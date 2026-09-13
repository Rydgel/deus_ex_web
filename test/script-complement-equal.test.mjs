import assert from 'node:assert/strict';
import test from 'node:test';
import {
  scriptStringComplementEqual,
  scriptStringText,
} from '../src/runtime/script-string-operations.mjs';
import { compileFunction, primitiveNativeIndices } from '../src/runtime/script-vm.mjs';

test('Core native 124 compares terminated strings with an ASCII case fold', () => {
  assert.ok(primitiveNativeIndices.includes(124));
  assert.equal(scriptStringComplementEqual('', ''), true);
  assert.equal(scriptStringComplementEqual('Hello', 'hELLo'), true);
  assert.equal(scriptStringComplementEqual('A\0ignored', 'a'), true);
  assert.equal(scriptStringComplementEqual('A😃Z', 'a😃z'), true);
  assert.equal(scriptStringComplementEqual('Hello', 'world'), false);
  assert.equal(scriptStringComplementEqual('é', 'É'), false);
  assert.equal(scriptStringComplementEqual('é', 'é'), true);
  assert.equal(scriptStringText('A\0ignored'), 'A');
  assert.throws(() => scriptStringComplementEqual(null, 'a'), /typed string/);
});

test('VM dispatches Core native 124 as a bool result', () => {
  const bytes = [0x04, 0x60, 124, 0x01, 0x01, 0x01, 0x02, 0x16];
  const vm = compileFunction({
    pkg: { imports: [], exports: [{ name: 'Value' }, { name: 'Amount' }] },
    entry: { path: 'Fixture.ComplementEqual' },
    bytes: Uint8Array.from(bytes),
    // Compact object references occupy four expanded bytes each.
    size: 14,
  });
  assert.equal(vm.run({ Value: 'MiXeD', Amount: 'mixed' }), true);
  assert.equal(vm.run({ Value: 'MiXeD', Amount: 'other' }), false);
});
