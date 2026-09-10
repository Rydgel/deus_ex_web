import test from 'node:test';
import assert from 'node:assert/strict';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';

// Isolate the recovered ProcessEvent ABI from bytecode execution, which has
// separate original-package checks. Core.dll 1013f7d0 copies the whole caller
// parameter area back; CallFunction's OutParm-only copyback is different.
test('ProcessEvent copies non-out parameters back and preserves the state continuation',()=>{
  const runtime=new ScriptRuntime({}),receiver={};
  const field={key:'fixture.timer.value',metadata:{type:'int',arrayDim:1,parameter:true}};
  let calls=0;
  const record={key:'fixture.timer',function:{
    script:{nativeIndex:0,functionFlags:0x800},fields:[field],parameters:[field],result:null,
    compiled:{run(object,locals){assert.equal(object,receiver);calls++;locals.set(field.key,locals.get(field.key)+1);}},
  }};
  const state=runtime.attach(receiver,{
    metadata:{probeMask:[1<<8,0],ignoreMask:[0xffffffff,0xffffffff]},methods:new Map([['timer',record]]),
  });
  state.latent=302;
  const args=[17];
  assert.equal(runtime.processEvent(receiver,'Timer',args),true);
  assert.deepEqual(args,[18]);assert.equal(state.latent,302);
  state.probeMask=[0,0];
  assert.equal(runtime.processEvent(receiver,'Timer',args),false);
  assert.equal(calls,1);assert.deepEqual(args,[18]);
});

test('singular script calls share a guard across event and function entry',()=>{
  const runtime=new ScriptRuntime({}),receiver={};let calls=0;
  const record={key:'fixture.timer',function:{
    script:{nativeIndex:0,functionFlags:0x820},fields:[],parameters:[],result:null,
    compiled:{run(){calls++;runtime.callFunction(record,receiver);}},
  }};
  runtime.attach(receiver,{
    metadata:{probeMask:[1<<8,0],ignoreMask:[0xffffffff,0xffffffff]},methods:new Map([['timer',record]]),
  });
  runtime.processEvent(receiver,'Timer');
  runtime.processEvent(receiver,'Timer');
  assert.equal(calls,2);assert.equal(runtime.instance(receiver).singular,false);
});

test('Enable/Disable use original probe indices and preserve state ignore masks',()=>{
  const runtime=new ScriptRuntime({}),receiver={};
  const state=runtime.attach(receiver,{
    metadata:{probeMask:[1<<8,1<<4],ignoreMask:[0xffffffff,0xffffffff]},methods:new Map(),
  });
  const control=(index,name)=>runtime.invokeNative({index,receiver,argumentCount:1,evaluateArgument:()=>name});
  control(118,'Timer');assert.equal(state.isProbing(0x134),false);
  control(117,'Timer');assert.equal(state.isProbing(0x134),true);
  control(118,'Tick');assert.equal(state.isProbing(0x150),false);
  state.stateNode={script:{probeMask:[0,0],ignoreMask:[0xffffffff,0]}};
  control(117,'Tick');assert.equal(state.isProbing(0x150),false);
  control(118,'OutsideProbeRange');assert.equal(state.isProbing(0x134),true);
});

test('omitted script arguments and Nothing holes retain zeroed parameter slots',()=>{
  const runtime=new ScriptRuntime({}),receiver={};
  const fields=['First','Second','Third'].map(name=>({key:name,metadata:{type:'int',arrayDim:1,parameter:true}}));
  const seen=[];
  const record={key:'fixture.optional',function:{script:{nativeIndex:0,functionFlags:2},fields,parameters:fields,result:null,
    compiled:{run(_,locals){seen.push(fields.map(field=>locals.get(field.key)));}},
  }};
  runtime.attach(receiver,{metadata:{probeMask:[0,0],ignoreMask:[0xffffffff,0xffffffff]},methods:new Map()});
  runtime.callFunction(record,receiver,1,()=>7);
  runtime.callFunction(record,receiver,3,index=>[7,undefined,9][index]);
  assert.deepEqual(seen,[[7,0,0],[7,0,9]]);
});
