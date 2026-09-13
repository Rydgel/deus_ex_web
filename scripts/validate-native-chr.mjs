/** Validate Core.Object.Chr (native 236) against the installed GOTY DLL. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import { compileFunction, primitiveNativeIndices } from '../src/runtime/script-vm.mjs';
import { scriptChr } from '../src/runtime/script-string-operations.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const python = process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const oracle = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-chr-oracle.py'), root,
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
assert.deepEqual(oracle.addresses, {
  nativeIndex: 236,
  thunk: '0x1010279d',
  body: '0x1013c520',
  fStringChrThunk: '0x10102117',
  fStringChrBody: '0x10145570',
  appStrlen: '0x10101b04',
  realloc: '0x10101753',
});
const thunk = coreDll.subarray(0x279d, 0x27a2);
assert.equal(thunk.toString('hex'), 'e97e9d0300', 'native 236 export thunk bytes');
assert.equal((0x101027a2 + thunk.readInt32LE(1)) >>> 0, 0x1013c520,
  'native 236 thunk target');
const bodyPrefix = coreDll.subarray(0x3c520, 0x3c520 + 20);
assert.equal(bodyPrefix.toString('hex'),
  '558bec83ec0c53568b75085733ff33d28b460c89',
  'native 236 body prefix');

const files = [];
for (const name of await readdir(`${root}/System`))
  files.push({ path: name, read: () => readFile(`${root}/System/${name}`) });
const core = await new AssetStore(files).get('Core');
const exportIndex = core.exportsByPath.get('object.chr');
assert.ok(exportIndex, 'missing Core.Object.Chr');
const metadata = readFunctionMetadata(core, exportIndex);
assert.equal(metadata.nativeIndex, 236);
assert.equal(metadata.scriptSize, 5);
assert.deepEqual(metadata.parameters.filter(parameter => !parameter.return).map(parameter => [
  parameter.name, parameter.type, parameter.optional,
]), [['i', 'int', false]]);
assert.ok(primitiveNativeIndices.includes(236), 'native 236 is linked');

for (const result of oracle.cases) {
  assert.equal(result.codeAdvance, 2, `${result.input}: EndFunctionParms cursor advance`);
  assert.deepEqual(result.events.map(event => event.kind), ['int'],
    `${result.input}: int operand evaluation`);
  assert.equal(result.events[0].value, result.input,
    `${result.input}: evaluated int value`);
  assert.equal(scriptChr(result.input), result.output,
    `${result.input}: translated output`);
  assert.equal(result.raw, result.output ? `${result.output}\0` : '',
    `${result.input}: FString terminator`);
  const expectedCount = result.output ? 2 : 0;
  assert.equal(result.count, expectedCount, `${result.input}: FString ArrayNum`);
  assert.equal(result.capacity, expectedCount, `${result.input}: FString ArrayMax`);
}

function run(value) {
  const bytes = new Uint8Array(8);
  bytes.set([0x04, 0xec, 0x1d]);
  new DataView(bytes.buffer).setInt32(3, value, true);
  bytes[7] = 0x16;
  return compileFunction({ entry: { path: 'Fixture.Chr' }, pkg: {}, bytes, size: bytes.length }).run({});
}
assert.equal(run(65), 'A', 'VM native 236 dispatch');
assert.equal(run(0x10041), 'A', 'VM native 236 low-word conversion');
assert.equal(run(0), '', 'VM native 236 zero result');

console.log(`Original Core native 236 passed ${oracle.cases.length} int/FString cases; ` +
  'low-word conversion, zero form, cursor advancement, ownership headers and VM dispatch match.');
