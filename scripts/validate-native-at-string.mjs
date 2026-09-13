/** Validate Core.Object.At_StrStr (native 168) against the original Core.dll. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import { compileFunction, primitiveNativeIndices } from '../src/runtime/script-vm.mjs';
import { scriptAt, scriptStringText } from '../src/runtime/script-string-operations.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const python = process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const oracle = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-at-string-oracle.py'), root,
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

assert.equal(oracle.addresses.nativeIndex, 168);
assert.equal(oracle.addresses.thunk, '0x10101e2e');
assert.equal(oracle.addresses.body, '0x1013ac30');
assert.equal(oracle.addresses.resultWriteBoundary, '0x1013ad29');
assert.equal(oracle.addresses.separator, '0x101aafcc');
assert.deepEqual(oracle.separator, {
  address: '0x101aafcc',
  bytes: '20000000',
  unit: 0x20,
  text: ' ',
});

// ImageBase 0x10100000 makes the native thunk's file RVA 0x1e2e.  Keep the
// bytes in the validator so a stale disassembly cannot silently validate.
const thunk = coreDll.subarray(0x1e2e, 0x1e33);
assert.equal(thunk.toString('hex'), 'e9fd8d0300', 'native 168 export thunk bytes');
assert.equal((0x10101e33 + thunk.readInt32LE(1)) >>> 0, 0x1013ac30,
  'native 168 export thunk target');
// 0x101aafcc - ImageBase = RVA/file offset 0xaafcc because the target is in
// the raw .data span.  The raw literal is the original TCHAR plus terminator.
assert.equal(coreDll.subarray(0xaafcc, 0xaafcc + 4).toString('hex'), '20000000',
  'Core separator raw bytes');

assert.match(coreU.toString('latin1'), /At_StrStr/);
const files = [];
for (const name of await readdir(`${root}/System`))
  files.push({ path: name, read: () => readFile(`${root}/System/${name}`) });
const core = await new AssetStore(files).get('Core');
const exportIndex = core.exportsByPath.get('object.at_strstr');
assert.ok(exportIndex, 'missing Core.Object.At_StrStr');
const metadata = readFunctionMetadata(core, exportIndex);
assert.equal(metadata.nativeIndex, 168);
assert.equal(metadata.scriptSize, 10);
assert.deepEqual(metadata.parameters.filter(parameter => !parameter.return).map(parameter => [
  parameter.name, parameter.type, parameter.optional,
]), [
  ['A', 'string', false],
  ['B', 'string', false],
]);

assert.ok(primitiveNativeIndices.includes(168), 'native 168 is linked');
const vm = compileFunction({
  pkg: { imports: [], exports: [] },
  entry: { path: 'Fixture.At' },
  bytes: Uint8Array.from([0x04, 0xa8, 0x1f, 65, 0, 0x1f, 66, 0, 0x16]),
  size: 9,
});
assert.equal(vm.run({}), 'A B', 'VM native 168 dispatch case');

for (const result of oracle.cases) {
  const label = `${result.left}/${result.right}`;
  assert.equal(result.codeAdvance, 3, `${label}: Code advance`);
  assert.deepEqual(result.events.map(event => event.kind), ['string', 'string'],
    `${label}: operand evaluation order`);
  assert.deepEqual(result.events.map(event => event.value), [result.left, result.right],
    `${label}: evaluated operands`);
  assert.equal(result.copies[0].source, '0x101aafcc', `${label}: static separator source`);
  assert.equal(result.copies[0].text, ' ', `${label}: static separator value`);
  assert.equal(result.output, scriptAt(result.left, result.right),
    `${label}: translated result`);
  assert.equal(result.output, scriptStringText(result.output));
  assert.equal(result.count, result.output.length + 1, `${label}: FString count`);
  assert.equal(result.capacity, result.count, `${label}: FString capacity`);
}

console.log(`Original Core native 168 passed ${oracle.cases.length} FFrame/FString cases; ` +
  'raw separator U+0020, operand order, result ownership and VM dispatch match.');
