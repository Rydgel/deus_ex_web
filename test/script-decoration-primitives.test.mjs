import test from 'node:test';
import assert from 'node:assert/strict';
import {compileFunction,reference} from '../src/runtime/script-vm.mjs';
import {executeDecorationPrimitive} from '../src/runtime/script-decoration-primitives.mjs';

test('out-int arithmetic reads the retained lvalue after later argument side effects',()=>{
  const script={pkg:{imports:[],exports:[{name:'Value',className:'IntProperty'}]},entry:{path:'Fixture.LiveOut'},
    bytes:Uint8Array.from([0x04,0x9f,0x01,1,0x61,0x2c,0x16,0x16]),size:11};
  const object={Value:10};
  const result=compileFunction(script).run(object,{}, {native:({index})=>{
    assert.equal(index,300);object.Value=5;return .5;
  }});
  assert.equal(result,2);assert.equal(object.Value,2);
  object.Value=0x7fffffff;
  // Exact product is 2147483902.99999988079071044921875. A JS double
  // rounds it up before truncation; the original retained product does not.
  assert.equal(executeDecorationPrimitive(159,[reference(object,'Value'),1+2**-23]),-2147483394);
});

test('float predicates and clamp preserve the recovered unordered branches',()=>{
  assert.equal(executeDecorationPrimitive(178,[NaN,1]),true);
  assert.equal(executeDecorationPrimitive(246,[NaN,2,3]),2);
  assert.equal(executeDecorationPrimitive(246,[1,0,NaN]),1);
  assert.ok(Object.is(executeDecorationPrimitive(246,[-0,-1,+0]),+0));
});
