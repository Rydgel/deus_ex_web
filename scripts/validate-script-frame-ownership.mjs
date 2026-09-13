import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdir,readFile} from 'node:fs/promises';
import {gameDirectory} from './game-directory.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';

const python=process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python';
const {cases,returnCase}=JSON.parse(execFileSync(python,['scripts/native-script-frame-oracle.py',gameDirectory()],{encoding:'utf8'}));
for(const original of cases){
  const runtime=new ScriptRuntime({}),receiver={},events=[];
  const fields=['parameter','local0','local1'].map((key,index)=>({key,kind:'StrProperty',
    metadata:{type:'string',flags:0x400000,arrayDim:1,parameter:index===0}}));
  let frame;
  const args=['input'];
  const record={key:'fixture.call',function:{fields,parameters:fields.slice(0,1),result:null,
    script:{nativeIndex:original.nativeIndex,functionFlags:2},compiled:{run(_,locals){
      frame=locals;events.push({op:'body'});
      assert.equal(locals.get('parameter'),'input');assert.equal(locals.get('local0'),'');assert.equal(locals.get('local1'),'');
      fields.forEach((field,index)=>locals.set(field.key,['changed','first','second'][index]));
    }}}};
  runtime.attach(receiver,{metadata:{probeMask:[0,0],ignoreMask:[0xffffffff,0xffffffff]},methods:new Map([['call',record]])});
  runtime.instance(receiver).pendingKill=original.pendingKill;
  const destroy=runtime.destroyProperties.bind(runtime);
  runtime.destroyProperties=(fields,referenceFor)=>{
    for(const field of fields){assert.equal(args[0],'changed');events.push({op:'destroy',field:field.key});}
    destroy(fields,referenceFor);
  };
  runtime.processEvent(receiver,'Call',args);
  assert.deepEqual(events,original.events.map(({op,field})=>field?{op,field}:{op}));
  assert.equal(original.depthAfter,0);
  if(frame){
    assert.deepEqual(original.events[0].initialParameter,original.initialParameter);
    assert.deepEqual(original.events[0].initialLocals,[0,0,0,0,0,0]);
    assert.deepEqual(original.parameterAfter,original.bodyValues[0]);
    for(const event of original.events.slice(1))assert.deepEqual(event.callerParameter,original.bodyValues[0]);
    assert.deepEqual(original.localsAfter,[...original.bodyValues[0],0,0,0,0,0,0]);
    assert.deepEqual([...frame.values()],['changed','','']);
    assert.deepEqual(original.allocatorEvents.map(({op,pointer})=>({op,pointer})),
      original.bodyValues.slice(1).flatMap(([pointer])=>[{op:'realloc',pointer},{op:'free',pointer}]));
  }else{
    assert.deepEqual(original.parameterAfter,original.initialParameter);
    assert.deepEqual(original.allocatorEvents,[]);assert.deepEqual(args,['input']);
  }
}
console.log(`Original Core.dll ProcessEvent: ${cases.length} ownership/gate cases matched; parameter copyback, local destructor order and allocator boundaries verified.`);
assert.equal(returnCase.events[0].resultPointerOffset,12);
assert.deepEqual(returnCase.events[0].initialLocals,[0,0,0]);
assert.deepEqual(returnCase.returnAfter,returnCase.bodyValues[1]);
assert.deepEqual(returnCase.events.slice(1).map(event=>event.field),['local0']);
assert.deepEqual(returnCase.events[1].callerReturn,returnCase.bodyValues[1]);
assert.deepEqual(returnCase.localsAfter,[...returnCase.bodyValues[0],...returnCase.bodyValues[1],0,0,0]);
assert.deepEqual(returnCase.allocatorEvents.map(({op,pointer})=>({op,pointer})),
  [{op:'realloc',pointer:returnCase.bodyValues[2][0]},{op:'free',pointer:returnCase.bodyValues[2][0]}]);

const root=gameDirectory(),files=(await readdir(`${root}/System`)).map(path=>({path,read:()=>readFile(`${root}/System/${path}`)}));
const assets=new AssetStore(files),runtime=new ScriptRuntime(assets),asset=await assets.get('DeusEx');
const cls=await runtime.loadClass(asset,asset.exportsByPath.get('colortheme'));
const receiver={};runtime.attach(receiver,cls);
const setter=await runtime.prepareFunction(asset,asset.exportsByPath.get('colortheme.setthemename'));
const getter=await runtime.prepareFunction(asset,asset.exportsByPath.get('colortheme.getthemename'));
assert.ok(setter.function.parameters[0].metadata.flags&0x400000);
assert.ok(getter.function.result.metadata.flags&0x400000);
const frames=[],execute=runtime.executeScript.bind(runtime);
runtime.executeScript=(fn,receiver,locals)=>{frames.push({fn,locals});return execute(fn,receiver,locals);};
runtime.callFunction(setter,receiver,1,()=> 'Original theme');
assert.equal(frames[0].locals.get(setter.function.parameters[0].key),'');
assert.equal(runtime.callFunction(getter,receiver),'Original theme');
const eventArgs=['Event theme'];runtime.processEvent(receiver,'SetThemeName',eventArgs);
assert.deepEqual(eventArgs,['Event theme']);
assert.equal(frames.at(-1).locals.get(setter.function.parameters[0].key),'Event theme');
assert.equal(runtime.callFunction(getter,receiver),'Event theme');
let eventResult='caller owns this';
assert.equal(runtime.processEvent(receiver,'GetThemeName',[],{
  reference:true,get:()=>eventResult,set:value=>{eventResult=value;},
}),true);
assert.equal(eventResult,'Event theme');
assert.equal(frames.at(-1).locals.get(getter.function.result.key),'Event theme');
console.log('Original ColorTheme setter/getter bytecode preserves assigned and returned strings across call cleanup and event copyback.');
console.log('Original ProcessEvent return pointer/copyback/destructor exclusion and ColorTheme return-bearing event block passed.');
