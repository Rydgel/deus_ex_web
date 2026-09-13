import assert from 'node:assert/strict';
import test from 'node:test';
import { scriptChr } from '../src/runtime/script-string-operations.mjs';
import { compileFunction, primitiveNativeIndices } from '../src/runtime/script-vm.mjs';

test('Core native 236 keeps the low UTF-16 word and preserves the raw zero form', () => {
  assert.ok(primitiveNativeIndices.includes(236));
  assert.equal(scriptChr(0), '');
  assert.equal(scriptChr(65), 'A');
  assert.equal(scriptChr(0x10041), 'A');
  assert.equal(scriptChr(-1), '\uffff');
  assert.equal(scriptChr(-0x10001), '\uffff');
  assert.equal(scriptChr(0x10000), '');
  assert.equal(scriptChr(0xd83d), '\ud83d');
  assert.equal(scriptChr(0xde03), '\ude03');
  assert.throws(() => scriptChr(1.5), /int32/);
  assert.throws(() => scriptChr(2 ** 31), /int32/);
});

test('VM dispatches Core native 236 with one int operand', () => {
  const bytes = new Uint8Array([0x04, 0xec, 0x1d, 0x41, 0x00, 0x00, 0x00, 0x16]);
  const vm = compileFunction({
    entry: { path: 'Fixture.Chr' },
    pkg: {},
    bytes,
    size: bytes.length,
  });
  assert.equal(vm.run({}), 'A');
});
