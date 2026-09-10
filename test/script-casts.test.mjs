import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFunction, reference } from '../src/runtime/script-vm.mjs';

const pkg = {
  imports: [],
  exports: [
    { name: 'TargetClass', className: 'Class' },
    { name: 'Source', className: 'ObjectProperty' },
  ],
};

function compile(op) {
  // The compact package references occupy one byte here, while each expands
  // to four bytes in the native script stream. A Return wrapper gives this
  // one-expression fixture the same terminating control flow as a function.
  return compileFunction({
    pkg,
    entry: { path: `Fixture.${op.toString(16)}` },
    bytes: Uint8Array.from([0x04, op, 1, 0x01, 2]),
    size: 11,
  });
}

test('DynamicCast and MetaCast evaluate target then child and delegate identity', () => {
  for (const [op, kind] of [[0x2e, 'dynamic'], [0x13, 'meta']]) {
    const vm = compile(op), instance = { Source: { id: 'source' } };
    const target = { key: 'target-class' }, events = [];
    const result = vm.run(instance, {}, {
      objectReference: (script, index) => {
        events.push(['target', index]);
        return target;
      },
      fieldReference: (receiver, script, node) => {
        events.push(['child', node.name, receiver]);
        return reference(receiver, 'Source');
      },
      castObject: (object, targetRecord, receivedKind) => {
        events.push(['cast', object, targetRecord, receivedKind]);
        return object;
      },
    });
    assert.equal(result, instance.Source);
    assert.equal(events[0][0], 'target');
    assert.deepEqual(events.map(event => event[0]), ['target', 'child', 'cast']);
    assert.equal(events[2][1], instance.Source);
    assert.equal(events[2][2], target);
    assert.equal(events[2][3], kind);
  }
});

test('Object casts pass a null child through the explicit service boundary', () => {
  const vm = compile(0x2e), target = { key: 'target-class' }, seen = [];
  const result = vm.run({ Source: null }, {}, {
    objectReference: () => target,
    castObject: (object, targetRecord, kind) => {
      seen.push([object, targetRecord, kind]);
      return null;
    },
  });
  assert.equal(result, null);
  assert.deepEqual(seen, [[null, target, 'dynamic']]);
});

test('Cast child uses FFrame.Object inside a different non-null context',()=>{
  for(const op of [0x13,0x2e]){
    const instance={Source:{id:'caller'},Context:{Source:{id:'context'}}};
    const vm=compileFunction({pkg:{...pkg,exports:[...pkg.exports,{name:'Context',className:'ObjectProperty'}]},
      entry:{path:'Fixture.ContextCast'},bytes:Uint8Array.from([0x04,0x19,0x01,3,10,0,4,op,1,0x01,2]),size:20});
    assert.equal(vm.run(instance,{}, {objectReference:()=>({}),castObject:value=>value}),instance.Source);
  }
});
