import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {
  DYNAMIC_LOAD_OBJECT_NATIVE,
  DynamicLoadObjectBoundaryError,
  execDynamicLoadObject,
} from '../src/runtime/script-dynamic-load-object.mjs';

const ROOT='Deus Ex GOTY Edition';

test('execDynamicLoadObject preserves argument order and original load flags',()=>{
  const objectClass={kind:'Class',key:'engine.texture'};
  const loaded={key:'infoportraits.jaimereyes'};
  for(const [arguments_,flags] of [
    [['InfoPortraits.JaimeReyes',objectClass],2],
    [['InfoPortraits.JaimeReyes',objectClass,false],2],
    [['InfoPortraits.JaimeReyes',objectClass,true],0x2002],
  ]){
    const events=[];
    const result=execDynamicLoadObject({argumentCount:arguments_.length,
      evaluateArgument:index=>{events.push(`argument:${index}`);return arguments_[index];}}, {
      staticLoadObject:request=>{events.push({request});return {object:loaded};},
      destroyString:value=>events.push(`destroy:${value}`),
    });
    assert.equal(result,loaded);
    assert.deepEqual(events.slice(0,arguments_.length),
      arguments_.map((_,index)=>`argument:${index}`));
    assert.deepEqual(events[arguments_.length],{request:{classRef:objectClass,outer:null,
      name:'InfoPortraits.JaimeReyes',filename:null,flags,sandbox:null}});
    assert.equal(events.at(-1),'destroy:InfoPortraits.JaimeReyes');
  }
  assert.equal(DYNAMIC_LOAD_OBJECT_NATIVE.body,0x1013eb30);
  assert.equal(DYNAMIC_LOAD_OBJECT_NATIVE.staticLoadThunk,0x10102a1d);
});

test('execDynamicLoadObject rejects suspension and still destroys the evaluated FString',()=>{
  const destroyed=[];
  assert.throws(()=>execDynamicLoadObject({argumentCount:2,
    evaluateArgument:index=>index===0?'Pkg.Item':{kind:'Class'}},{
      staticLoadObject:()=>Promise.resolve(null),destroyString:value=>destroyed.push(value),
    }),error=>error instanceof DynamicLoadObjectBoundaryError&&
      error.code==='DYNAMIC_LOAD_OBJECT_ASYNC');
  assert.deepEqual(destroyed,['Pkg.Item']);
});

test('ScriptRuntime DynamicLoadObject returns one prepared canonical package export',async()=>{
  const files=[];
  for(const [directory,name] of [['System','Core.u'],['System','Engine.u'],
    ['System','DeusExUI.u'],['Textures','InfoPortraits.utx']])files.push({
    path:`${directory}/${name}`,read:()=>fs.readFile(`${ROOT}/${directory}/${name}`),
  });
  const assets=new AssetStore(files),runtime=new ScriptRuntime(assets);
  const [core,engine]=await Promise.all([assets.get('Core'),assets.get('Engine')]);
  const native=await runtime.prepareFunction(core,core.exportsByPath.get('object.dynamicloadobject'));
  const texture=(await runtime.loadClass(engine,engine.exportsByPath.get('texture'))).record;
  const palette=(await runtime.loadClass(engine,engine.exportsByPath.get('palette'))).record;
  const expected=await runtime.prepareDynamicLoadObject('InfoPortraits.JaimeReyes');
  assert.equal(runtime.dynamicLoadGraph.linkers.length,0,
    'the focused portrait package must construct its linker on first StaticLoadObject');
  assert.equal(runtime.dynamicLoadGraph.linkerByPackage.has('infoportraits'),false);
  const actual=runtime.callFunction(native,{},2,index=>
    index===0?'InfoPortraits.JaimeReyes':texture);
  assert.strictEqual(actual,expected);
  assert.strictEqual(runtime.dynamicLoadGraph.preparedObject('InfoPortraits.JaimeReyes'),expected);
  assert.deepEqual(runtime.dynamicLoadGraph.lastEvents.map(event=>event.op),[
    'StaticLoadObject','BeginLoad','ResolveName','GetPackageLinker','CreateLinkerLoad','FName',
    'FindExportIndex','CreateExport','EndLoad','Logf','FArrayRealloc',
  ]);
  const firstLinker=runtime.dynamicLoadGraph.linkerByPackage.get('infoportraits');
  assert.equal(firstLinker.kind,'ULinkerLoad');
  assert.equal(firstLinker.constructor.body,0x10160000);
  assert.equal(firstLinker.archive.nativeVtable,0x1017a430);
  assert.equal(firstLinker.archive.baseVtable,0x101751f8);
  assert.equal(firstLinker.archive.version,0x44);
  assert.equal(firstLinker.archive.licenseeVersion,0x44c);
  assert.ok(firstLinker.reader);
  assert.equal(runtime.dynamicLoadGraph.lastEvents.find(event=>event.op==='FindExportIndex').index,27);
  assert.equal(runtime.dynamicLoadGraph.lastEvents.find(event=>event.op==='GetPackageLinker').flags,0x2a);
  assert.equal(runtime.dynamicLoadGraph.loadState.nest,0);
  assert.deepEqual(runtime.dynamicLoadGraph.lifecycleEdges.map(event=>event.op),['Logf','FArrayRealloc']);

  assert.strictEqual(runtime.callFunction(native,{},3,index=>
    ['InfoPortraits.JaimeReyes',texture,true][index]),expected);
  assert.equal(runtime.dynamicLoadGraph.lastEvents.find(event=>event.op==='GetPackageLinker').flags,0x202a);

  const icon=await runtime.prepareDynamicLoadObject('DeusExUI.UserInterface.DataLinkIcon');
  assert.strictEqual(runtime.callFunction(native,{},2,index=>
    ['DeusExUI.UserInterface.DataLinkIcon',texture][index]),icon);
  assert.equal(runtime.dynamicLoadGraph.lastEvents.find(event=>event.op==='FindExportIndex').index,
    icon.index-1);
  assert.equal(runtime.dynamicLoadGraph.linkers.length,2);

  assert.throws(()=>runtime.callFunction(native,{},2,index=>
    index===0?'InfoPortraits.NotPrepared':texture),error=>
    error instanceof DynamicLoadObjectBoundaryError&&
    error.code==='DYNAMIC_LOAD_OBJECT_STATIC_FIND');
  assert.throws(()=>runtime.callFunction(native,{},2,index=>
    index===0?'Missing.Nope':texture),error=>
    error instanceof DynamicLoadObjectBoundaryError&&
    error.code==='DYNAMIC_LOAD_OBJECT_FIRST_LOAD');
  assert.throws(()=>runtime.callFunction(native,{},2,index=>
    index===0?'InfoPortraits.JaimeReyes':palette),error=>
    error instanceof DynamicLoadObjectBoundaryError&&
    error.code==='DYNAMIC_LOAD_OBJECT_STATIC_FIND');
});
