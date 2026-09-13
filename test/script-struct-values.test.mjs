import test from 'node:test';
import assert from 'node:assert/strict';
import {readScriptStructValue} from '../src/runtime/script-struct-values.mjs';

const field=(key,type,extra={})=>({key,metadata:{type,arrayDim:1,flags:0,...extra}});
const structure=(key,fields,extra={})=>field(key,'struct',{structKey:key,structFields:fields,...extra});
const asset={pkg:{version:69,names:[{name:'None'},{name:'Alliance'}],exports:[{}],imports:[{}]}};

test('struct payload follows member/ArrayDim order and resolves references in the value package',async()=>{
  const name=field('record.name','name'),objects=field('record.targets','object',{arrayDim:2});
  const text=field('record.text','string',{flags:0x400000});
  const nested=structure('record.inner',[field('inner.enabled','bool'),field('inner.count','int')]);
  const top=structure('record',[name,objects,text,nested],{arrayDim:3});
  const identities=[{},{}],calls=[];
  const value=await readScriptStructValue(asset,top,Uint8Array.from([1,1,0x81,4,97,98,99,0,2,42,0,0,0]),{
    resolveObject:(source,index)=>{assert.equal(source,asset);calls.push(index);return identities[index>0?0:1];},
  });
  assert.deepEqual(calls,[1,-1]);
  assert.deepEqual(value,{'record.name':'Alliance','record.targets':identities,'record.text':'abc',
    'record.inner':{'inner.enabled':true,'inner.count':42}});
  assert.equal(value['record.targets'][0],identities[0]);
});

test('skipped struct members retain initialized values and transient archive state stays explicit',async()=>{
  const native=field('record.native','int',{flags:0x1000});
  const transient=field('record.transient','string',{flags:0x402000});
  const ordinary=field('record.value','byte');
  const top=structure('record',[native,transient,ordinary]);
  const initial={'record.native':73,'record.transient':'keep','record.value':0};
  assert.deepEqual(await readScriptStructValue(asset,top,Uint8Array.of(9),{initialValue:initial,persistent:true}),
    {...initial,'record.value':9});
  assert.equal(initial['record.value'],0);
  await assert.rejects(readScriptStructValue(asset,top,Uint8Array.of(9),{initialValue:initial}),/archive persistence/);
  assert.deepEqual(await readScriptStructValue(asset,top,Uint8Array.of(0,9),{initialValue:initial,persistent:false}),
    {...initial,'record.transient':'','record.value':9});
});

test('struct loader enforces payload bounds and rejects unresolved member serialization',async()=>{
  const top=structure('record',[field('record.value','int')]);
  await assert.rejects(readScriptStructValue(asset,top,Uint8Array.of(1)),/end|bounds|Truncated/i);
  await assert.rejects(readScriptStructValue(asset,top,Uint8Array.of(1,0,0,0,2)),/Unexpected serialized struct size/);
  await assert.rejects(readScriptStructValue(asset,structure('record',[field('record.values','array')]),Uint8Array.of(0)),/Dynamic array/);
});
