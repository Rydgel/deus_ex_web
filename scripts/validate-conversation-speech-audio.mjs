import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {conversationSpeechAudio} from '../src/runtime/script-conversation-speech-audio.mjs';
import {gameDirectory} from './game-directory.mjs';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';

const native=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-conversation-speech-audio-oracle.py',gameDirectory()],{encoding:'utf8',maxBuffer:2**20}));
assert.equal(native.hashes['ConSys.dll'],'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa');
const events=[],arrays=[];
const conversation={Outer:{Name:'DeusExConText'},audioPackageName:'Mission00'};
const soundClass={label:'Engine.Sound.PrivateStaticClass'},sound={label:'ConAudio(Mission00,123)'};
const dataNames=new Map(),header=array=>[dataNames.get(array.data)??array.data,array.num,array.max];
const write=(array,field,value)=>{
  array[field]=value;
  events.push({op:'FieldWrite',kind:array.kind,field,value:field==='data'?(dataNames.get(value)??value):value});
};
const free=pointer=>events.push({op:'FMalloc::Free',pointer:dataNames.get(pointer)});
const services={
  read:(object,key)=>object[key],write,soundClass,
  copyString:({source})=>{events.push({op:'appStrcpy',source});return source;},
  equalText:(left,right)=>{
    assert.equal(left,'Text');assert.equal(right,'Text');
    events.push({op:'appStricmp',left,right,result:0});return true;
  },
  formatString:({format,args})=>{
    const kind=arrays.length?'filename':'objectName';
    const result=kind==='objectName'?`ConAudio${args[0]}_${args[1]}`:`..\\System\\${args[0]}Audio${args[1]}.u`;
    const data=Uint16Array.from([...result].map(char=>char.charCodeAt(0)).concat(0));
    const array={kind,data,num:data.length,max:data.length};
    arrays.push(array);dataNames.set(data,`${kind}.data`);
    events.push({op:'FString::Printf',kind,format,arguments:args,result,data:`${kind}.data`,num:data.length,max:data.length});
    return array;
  },
  stringText:(data,num)=>String.fromCharCode(...data.subarray(0,num-1)),
  staticLoadObject:request=>{
    const {classRef,...args}=request;
    events.push({op:'StaticLoadObject',class:classRef.label,...args,result:sound.label});return sound;
  },
  arrayRealloc:(array,size)=>{
    assert.equal(size,2);assert.equal(array.num,0);assert.equal(array.max,0);
    events.push({op:'ReallocBody',kind:array.kind,header:header(array)},
      {op:'FArray::Realloc',pointer:dataNames.get(array.data),bytes:0,elementSize:size,tag:'0x101ab50c'});
    write(array,'data',array.data);
  },
  arrayRemove:(array,index,count,size)=>{
    assert.deepEqual([index,count,size],[0,0,2]);
    events.push({op:'RemoveBody',kind:array.kind,header:header(array),arguments:[index,count,size]});
  },
  arrayDestroy:array=>{
    events.push({op:'ArrayDestroyBody',kind:array.kind,header:header(array)});
    free(array.data);write(array,'data',0);write(array,'max',0);write(array,'num',0);
  },
  allocatorFree:free,
};
assert.equal(conversationSpeechAudio(conversation,123,services),sound);
const nativeData=new Map(native.ordinary.events.filter(event=>event.op==='FString::Printf')
  .map(event=>[Number(event.data),`${event.kind}.data`]));
const pointer=value=>nativeData.get(Number(value))??value;
const expected=native.ordinary.events.filter(event=>event.op!=='appStrlen').map(event=>{
  if(event.op==='FString::Printf'){
    const {resultRecord,...rest}=event;return {...rest,data:pointer(event.data)};
  }
  if(event.op==='FieldWrite')return {...event,value:event.field==='data'?pointer(event.value):event.value};
  if(event.header)return {...event,header:[pointer(event.header[0]),...event.header.slice(1)]};
  if(event.pointer)return {...event,pointer:pointer(event.pointer)};
  return event;
});
assert.deepEqual(events,expected,'original generated lookup and owning FString cleanup order');
assert.equal(conversationSpeechAudio(null,-1),null);
assert.equal(native.soundIDMinusOne.result,null);
assert.deepEqual(native.soundIDMinusOne.events,[]);
assert.deepEqual(conversation,{Outer:{Name:'DeusExConText'},audioPackageName:'Mission00'});
const root=gameDirectory();
const assets=new AssetStore((await readdir(path.join(root,'System'))).map(name=>({
  path:`System/${name}`,read:()=>readFile(path.join(root,'System',name)),
})));
const runtime=new ScriptRuntime(assets),conSys=await assets.get('ConSys'),receiver={};
runtime.attach(receiver,await runtime.loadClass(conSys,conSys.exportsByPath.get('conversation')));
runtime.namedReference(receiver,'Outer').set(conversation.Outer);
runtime.namedReference(receiver,'audioPackageName').set(conversation.audioPackageName);
const fn=await runtime.prepareFunction(conSys,conSys.exportsByPath.get('conversation.getspeechaudio'));
assert.equal(runtime.callFunction(fn,receiver,1,()=>-1),null);
arrays.length=0;events.length=0;
runtime.conversationLifecycle={audio:{speechLookup:{...services,
  read:(object,key)=>object===receiver?runtime.namedReference(object,key).get():object[key],
}}};
assert.equal(runtime.callFunction(fn,receiver,1,()=>123),sound);
assert.deepEqual(events,expected,'shared native2055 uses typed conversation fields and the same original lifecycle');
console.log('Original GetSpeechAudio matches: generated object/filename, StaticLoadObject arguments, two temporary array lifecycles and service-free -1.');
console.log('Shared native2055 dispatch reaches the verified lookup through typed Conversation fields.');
