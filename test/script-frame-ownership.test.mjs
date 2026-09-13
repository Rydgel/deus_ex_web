import test from 'node:test';
import assert from 'node:assert/strict';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {propertyReference} from '../src/runtime/script-values.mjs';

const stringField=(name,extra={})=>({key:`fixture.call.${name}`,kind:'StrProperty',metadata:{
  type:'string',arrayDim:1,flags:0x400000,...extra,
}});
function fixture(fields,parameters,result,run){
  const runtime=new ScriptRuntime({}),receiver={};
  const record={key:'fixture.call',function:{fields,parameters,result,
    script:{nativeIndex:0,functionFlags:2},compiled:{run}}};
  runtime.attach(receiver,{metadata:{probeMask:[0xffffffff,0xffffffff],ignoreMask:[0xffffffff,0xffffffff]},
    methods:new Map([['call',record]])});
  return {runtime,receiver,record};
}

test('CallFunction copies return/out values before destroying all owning temporaries',()=>{
  const first=stringField('first',{parameter:true,out:true});
  const second=stringField('second',{parameter:true,out:true});
  const result=stringField('result',{parameter:true,return:true});
  const local=stringField('local');
  let frame,caller='input';const order=[];
  const {runtime,receiver,record}=fixture([first,second,result,local],[first,second],result,(_,locals)=>{
    frame=locals;
    assert.equal(locals.get(local.key),'');
    assert.equal(locals.get(first.key),'input');
    locals.set(first.key,'first value');locals.set(second.key,'second value');
    locals.set(local.key,'scratch');locals.set(result.key,'return value');
    return locals.get(result.key);
  });
  const ref=field=>propertyReference(field,()=>caller,value=>{order.push(field.key);caller=value;});
  const destroy=runtime.destroyProperties.bind(runtime);
  runtime.destroyProperties=(fields,referenceFor)=>{
    assert.equal(caller,'first value');
    order.push(...fields.map(field=>`destroy:${field.key}`));
    destroy(fields,referenceFor);
  };
  assert.equal(runtime.callFunction(record,receiver,2,index=>ref([first,second][index])),'return value');
  assert.equal(caller,'first value');
  assert.deepEqual([...frame.values()],['','','','']);
  assert.deepEqual(order,[second.key,first.key,...[first,second,result,local].map(field=>`destroy:${field.key}`)]);
});

test('ProcessEvent copies owning parameters back and destroys only its local suffix',()=>{
  const parameter=stringField('parameter',{parameter:true}),local=stringField('local');
  let frame;
  const {runtime,receiver}=fixture([parameter,local],[parameter],null,(_,locals)=>{
    frame=locals;assert.equal(locals.get(parameter.key),'input');assert.equal(locals.get(local.key),'');
    locals.set(parameter.key,'changed');locals.set(local.key,'scratch');
  });
  const args=['input'];
  assert.equal(runtime.processEvent(receiver,'Call',args),true);
  assert.deepEqual(args,['changed']);
  assert.equal(frame.get(parameter.key),'changed');assert.equal(frame.get(local.key),'');
});

test('nested events clean independent owning struct locals and preserve object members',()=>{
  const member=stringField('record.title'),target={key:'fixture.record.target',kind:'ObjectProperty',
    metadata:{type:'object',arrayDim:1,flags:0}};
  const local={key:'fixture.call.record',kind:'StructProperty',metadata:{type:'struct',arrayDim:1,
    flags:0x400000,structKey:'fixture.record',structFields:[member,target]}};
  const frames=[],identity={};let depth=0;
  const {runtime,receiver}=fixture([local],[],null,(_,locals)=>{
    frames.push(locals);assert.equal(locals.get(local.key)[member.key],'');
    locals.set(local.key,{[member.key]:depth?'inner':'outer',[target.key]:identity});
    if(!depth++){runtime.processEvent(receiver,'Call');assert.equal(locals.get(local.key)[member.key],'outer');}
  });
  runtime.processEvent(receiver,'Call');
  assert.equal(frames.length,2);
  for(const frame of frames)assert.deepEqual(frame.get(local.key),{[member.key]:'',[target.key]:identity});
});

test('ProcessEvent return slot is caller-owned and survives local cleanup and early gates',()=>{
  const result=stringField('result',{parameter:true,return:true}),local=stringField('local');
  let frame,caller='initial';
  const {runtime,receiver,record}=fixture([result,local],[],result,(_,locals)=>{
    frame=locals;assert.equal(locals.get(result.key),'initial');
    locals.set(local.key,'temporary');return 'returned';
  });
  const reference=propertyReference(result,()=>caller,value=>{caller=value;});
  const destroy=runtime.destroyProperties.bind(runtime);
  runtime.destroyProperties=(fields,referenceFor)=>{
    assert.equal(caller,'returned');assert.deepEqual(fields,[local]);destroy(fields,referenceFor);
  };
  assert.equal(runtime.processEvent(receiver,'Call',[],reference),true);
  assert.equal(caller,'returned');assert.deepEqual([...frame.values()],['returned','']);
  runtime.destroyProperties=destroy;
  runtime.instance(receiver).pendingKill=1;caller='preserved';
  assert.equal(runtime.processEvent(receiver,'Call',[],reference),false);assert.equal(caller,'preserved');
  runtime.instance(receiver).pendingKill=0;
  runtime.instance(receiver).singular=true;record.function.script.functionFlags|=0x20;
  assert.equal(runtime.processEvent(receiver,'Call',[],reference),true);assert.equal(caller,'preserved');
});

test('ProcessEvent rejects pending kill before native-index equality, including a nonzero high word',()=>{
  let calls=0;
  const {runtime,receiver,record}=fixture([],[],null,()=>calls++);
  for(const [pendingKill,nativeIndex] of [[1,1],[0x10000,0],[0,1]]){
    runtime.instance(receiver).pendingKill=pendingKill;record.function.script.nativeIndex=nativeIndex;
    assert.equal(runtime.processEvent(receiver,'Call'),false);
  }
  assert.equal(calls,0);
});
