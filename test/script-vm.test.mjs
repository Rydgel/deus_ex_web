import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFunction, primitiveNativeIndices } from '../src/runtime/script-vm.mjs';

const pkg = { imports: [], exports: [{ name: 'Value' }, { name: 'Amount' }] };
function compile(bytes, size) { return compileFunction({ pkg, entry: { path: 'Fixture' }, bytes: Uint8Array.from(bytes), size }); }
test('Assert evaluates once, continues on true and stops on false with the source line',()=>{
  const vm=compile([9,234,0,1,1,4,38],10);
  let calls=0;
  assert.equal(vm.run({get Value(){calls++;return true;}}),1);
  assert.equal(calls,1);
  assert.throws(()=>vm.run({Value:false}),/Script assertion failed: Fixture, line 234/);
});
test('VM resolves local/instance references, native out parameters, and float32 arithmetic', () => {
  // Value += Amount; return Value. Serialized field indices expand to 4 bytes.
  const vm = compile([184, 1, 1, 0, 2, 22, 4, 1, 1], 18);
  const instance = { Value: Math.fround(.1) };
  assert.equal(vm.run(instance, { Amount: Math.fround(.2) }), Math.fround(Math.fround(.1) + Math.fround(.2)));
  const toByte = compile([0x04, 0x43, 0x01, 1], 7);
  assert.equal(toByte.run({Value: 300.9}), 44);
  assert.equal(toByte.run({Value: -1.9}), 255);
  assert.equal(toByte.run({Value: 255.99999999}), 0);
  assert.throws(() => toByte.run({Value: NaN}), /nonfinite\/overflow/);
});
test('VM follows expanded jump addresses and fails closed on invalid/unsupported programs', () => {
  // if (Value < Amount) return 1; return 0;
  const bytes = [7, 17, 0, 176, 1, 1, 0, 2, 22, 4, 38, 4, 37];
  const vm = compile(bytes, 19);
  assert.equal(vm.run({ Value: 1 }, { Amount: 2 }), 1);
  assert.equal(vm.run({ Value: 3 }, { Amount: 2 }), 0);
  assert.throws(() => compile([0x03], 1), /opcode/);
  assert.throws(() => compile([6, 1, 0, 4, 11], 5), /boundary/);
  assert.throws(() => compile([6, 0, 0], 3).run({}, {}), /budget/);
  assert.throws(() => compile([127, 22, 4, 11], 4).run({}, {}), /typed string/);
});

test('object equality uses native114 and native118 reaches host Disable dispatch',()=>{
  assert.equal(compile([4,114,0x2a,0x2a,0x16],5).run({}),true);
  let index;
  compile([118,0x2a,0x16,4,0x0b],5).run({}, {}, {invokeNative:call=>{index=call.index;}});
  assert.equal(index,118);
});

function floatNative(index,a,b) {
  // Field references allow NaN values from the host object; package float
  // literals intentionally reject nonfinite data.
  const bytes=[0x04,0x60,index,0x01,0x01,0x01,0x02,0x16];
  return compile(bytes,14).run({Value:a,Amount:b});
}

test('native float equality uses float32 operands and original unordered result',()=>{
  assert.equal(floatNative(0xb4,1,1+2**-25),true);
  assert.equal(floatNative(0xb4,NaN,3),true);
  assert.equal(floatNative(0xb5,1,1+2**-25),false);
  assert.equal(floatNative(0xb5,NaN,3),false);
  assert.equal(floatNative(0xb5,1,2),true);
  assert.equal(floatNative(0xb4,-0,+0),true);
});

test('radiation path Core primitives preserve float32 stores and out lvalues', () => {
  const binary = index => [0x04, 0x60, index, 0x01, 0x01, 0x01, 0x02, 0x16];
  const unary = index => [0x04, 0x60, index, 0x01, 0x01, 0x16];
  for (const index of [144, 169, 185, 213, 223])
    assert.ok(primitiveNativeIndices.includes(index), `native ${index} is linked`);

  assert.equal(compile(binary(144), 14).run({ Value: 300, Amount: -7 }), -2100);
  assert.equal(compile(unary(169), 9).run({ Value: 3.5, Amount: 0 }), -3.5);

  const subtract = { Value: 1 + 2 ** -25, Amount: 0.25 };
  assert.equal(compile(binary(185), 14).run(subtract), Math.fround(0.75));
  assert.equal(subtract.Value, Math.fround(0.75));

  assert.deepEqual(compile(binary(213), 14).run({ Value: 0.1, Amount: [1, -2, 50] }),
    [Math.fround(0.1), Math.fround(-0.2), Math.fround(5)]);

  const add = { Value: [0.1, -2, 3], Amount: [0.2, 4, -5] };
  assert.deepEqual(compile(binary(223), 14).run(add),
    [Math.fround(0.3), Math.fround(2), Math.fround(-2)]);
  assert.deepEqual(add.Value, [Math.fround(0.3), Math.fround(2), Math.fround(-2)]);
});

test('native discard metadata follows statement Context values, not consumed operands', () => {
  const cases = [
    {bytes:[0x61,8,0x16,4,11],size:5,flags:[true]},
    {bytes:[4,0x61,8,0x16],size:4,flags:[false]},
    {bytes:[15,1,1,0x61,8,0x16,4,11],size:11,flags:[false]},
    {bytes:[0x19,1,1,3,0,4,0x61,8,0x16,4,11],size:14,flags:[true]},
    {bytes:[0x61,9,0x61,8,0x16,0x16,4,11],size:8,flags:[true,false]},
    {bytes:[0x19,0x61,8,0x16,3,0,4,0x61,8,0x16,4,11],size:12,flags:[false,true]},
  ];
  for (const {bytes,size,flags} of cases) {
    const seen=[];
    compile(bytes,size).run({Value:{}},{},{invokeNative:call=>{
      seen.push(call.resultDiscarded);
      for(let i=0;i<call.argumentCount;i++)call.evaluateArgument(i);
      return {};
    }});
    assert.deepEqual(seen,flags);
  }
});
