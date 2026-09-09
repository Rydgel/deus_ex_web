import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFunction } from '../src/runtime/script-vm.mjs';

const pkg = { imports: [], exports: [{ name: 'Value' }, { name: 'Amount' }] };
function compile(bytes, size) { return compileFunction({ pkg, entry: { path: 'Fixture' }, bytes: Uint8Array.from(bytes), size }); }
test('VM resolves local/instance references, native out parameters, and float32 arithmetic', () => {
  // Value += Amount; return Value. Serialized field indices expand to 4 bytes.
  const vm = compile([184, 1, 1, 0, 2, 22, 4, 1, 1], 18);
  const instance = { Value: Math.fround(.1) };
  assert.equal(vm.run(instance, { Amount: Math.fround(.2) }), Math.fround(Math.fround(.1) + Math.fround(.2)));
});
test('VM follows expanded jump addresses and fails closed on invalid/unsupported programs', () => {
  // if (Value < Amount) return 1; return 0;
  const bytes = [7, 17, 0, 176, 1, 1, 0, 2, 22, 4, 38, 4, 37];
  const vm = compile(bytes, 19);
  assert.equal(vm.run({ Value: 1 }, { Amount: 2 }), 1);
  assert.equal(vm.run({ Value: 3 }, { Amount: 2 }), 0);
  assert.throws(() => compile([0x5f], 1), /opcode/);
  assert.throws(() => compile([6, 1, 0, 4, 11], 5), /boundary/);
  assert.throws(() => compile([6, 0, 0], 3).run({}, {}), /budget/);
  assert.throws(() => compile([255, 22, 4, 11], 4).run({}, {}), /native 255/);
});
