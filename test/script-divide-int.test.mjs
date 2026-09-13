import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFunction, primitiveNativeIndices } from '../src/runtime/script-vm.mjs';

const pkg = { imports: [], exports: [{ name: 'A' }, { name: 'B' }] };
const bytes = Uint8Array.from([0x04, 0x60, 145, 0x01, 0x01, 0x01, 0x02, 0x16]);
const vm = compileFunction({ pkg, entry: { path: 'Fixture.DivideIntInt' }, bytes, size: 14 });

test('native 145 performs signed int32 division and the original zero guard', () => {
  assert.ok(primitiveNativeIndices.includes(145));
  const cases = [
    [[19, 4], 4],
    [[-19, 4], -4],
    [[19, -4], -4],
    [[-19, -4], 4],
    [[-(2 ** 31), 1], -(2 ** 31)],
    [[-(2 ** 31), -2], 2 ** 30],
    [[123, 0], 0],
  ];
  for (const [[dividend, divisor], expected] of cases)
    assert.equal(vm.run({ A: dividend, B: divisor }), expected, `${dividend}/${divisor}`);
});

test('native 145 evaluates operands left to right and keeps signed overflow explicit', () => {
  const order = [];
  const receiver = {};
  Object.defineProperties(receiver, {
    A: { get() { order.push('A'); return 19; } },
    B: { get() { order.push('B'); return -4; } },
  });
  assert.equal(vm.run(receiver), -4);
  assert.deepEqual(order, ['A', 'B']);
  assert.throws(() => vm.run({ A: -(2 ** 31), B: -1 }),
    /Divide_IntInt signed overflow \(x86 divide exception\)/);
});
