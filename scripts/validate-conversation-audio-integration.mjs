/** One original DL_Start integration: typed Conversation -> speech lookup ->
 * existing filename linker/export -> retained sound archive -> native timing.
 * File/name/allocator and initialized loader state remain explicit fixtures.
 */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {Reader} from '../src/unreal/package.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {staticLoadObject} from '../src/runtime/script-static-load-object.mjs';
import {resolveNameNative} from '../src/runtime/script-resolve-name.mjs';
import {constructSoundNative} from '../src/runtime/script-sound-construction.mjs';
import {serializeSoundHelperLifecycle,serializeSoundByteArray,destroySoundDataLifecycle} from '../src/runtime/script-sound-lifecycle.mjs';
import {createLinkerLoadArchive,attachLinkerLazyLoader,detachLinkerLazyLoader} from '../src/runtime/script-linker-lazy-loader.mjs';
import {loadSoundDataSpecial} from '../src/runtime/script-sound-load.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory();
const assets=new AssetStore((await readdir(path.join(root,'System'))).map(name=>({
  path:`System/${name}`,read:()=>readFile(path.join(root,'System',name)),
})));
const runtime=new ScriptRuntime(assets);
const context=await assets.get('DeusExConText'),audio=await assets.get('DeusExConAudioMission00');
const conversation=await runtime.prepareObject(await runtime.objects.resolve(context,1926));
assert.equal(runtime.namedReference(conversation,'conName').get(),'DL_Start');
const index=audio.exportsByPath.get('conaudiomission00_79'),entry=audio.pkg.exports[index-1];
assert.equal(index,81);
// USound is a native-only class, so use the canonical resource graph rather
// than asking the script-class loader to invent an Engine.u Sound export.
const sound=await runtime.objects.resolve(audio,index);
const soundResource=await runtime.prepareResource(sound);
const soundClass=soundResource.nativeClass;
const soundOuter=soundResource.outer;
const classOuter=await runtime.resources.package(soundClass.packageName);
const read=(object,key)=>runtime.instances.has(object)?runtime.namedReference(object,key).get():object[key];
const write=(object,key,value)=>{object[key]=value;};
const reader=new Reader(audio.bytes);reader.offset=entry.serialOffset;
assert.equal(audio.pkg.names[reader.compact()].name,'None');
assert.equal(audio.pkg.names[reader.compact()].name,'mp3');
const freed=[];
const realloc=(array,size)=>{
  if(array.max===0){if(array.data)freed.push(array.data);array.data=null;return;}
  assert.equal(array.data,null);
  array.data=size===1?new Uint8Array(array.max):Array(array.max).fill(null);
};
const removeAll=(array,start,count,size)=>{
  assert.equal(start,0);assert.equal(count,array.num);
  array.num=0;array.max=0;realloc(array,size);
};
const linker={outer:soundOuter,reader:{label:'initialized linker +0x90'}};
const archive=createLinkerLoadArchive({linker,reader:{tell:()=>reader.offset},
  services:{arrayRealloc:realloc,arrayRemove:removeAll,log:()=>assert.fail('Unexpected detach mismatch')}});
Object.assign(archive,{version:audio.pkg.version,ar0c:1,ar10:0,serializationFlag:1});
const storage={identity:sound,serializedByteCount:0};constructSoundNative(storage,{arrayRealloc:realloc});
const data=storage.soundData;
const archiveServices={
  attachLazyLoader:(archive,data)=>attachLinkerLazyLoader(archive,data),
  tell:current=>{assert.equal(current,archive);return reader.offset;},
  seek:(current,position)=>{assert.equal(current,archive);assert.ok(position>=0&&position<=audio.bytes.length);reader.offset=position;},
  countBytes:(current,num,max)=>{assert.equal(current,archive);assert.equal(num,0);assert.equal(max,0);},
  serializeCompact:(current,holder)=>{assert.equal(current,archive);holder.value=reader.compact();},
  serializeRaw:(current,holder,width)=>{
    assert.equal(current,archive);
    if(holder.value instanceof Uint8Array)holder.value.set(reader.take(width));
    else{assert.equal(width,4);holder.value=reader.u32();}
  },arrayRealloc:realloc,
};
serializeSoundHelperLifecycle(storage,archive,archiveServices);
const savedCursor=reader.offset,savedPosition=data.lazyField08;
assert.ok(savedPosition>0);assert.equal(data.array.num,0);
const nameIndex=text=>{
  const index=audio.pkg.names.findIndex(entry=>entry.name===text);
  assert.ok(index>=0,`Missing fixture FName ${text}`);return index;
};
// Package-local numbers provide one consistent fixture namespace; they are
// not claimed to be original process-wide GNames slots.
const className=nameIndex('Sound'),classPackage=nameIndex('Engine'),objectName=nameIndex(entry.name);
const exportRecord={classIndex:entry.classIndex,outerIndex:entry.outer,nameIndex:objectName,object:sound,nextHash:-1};
const loadState={nest:0,registrationQueueHead:null,loadedMax:0,loaderCleanupState:0};
const loadedObjects=[],loads=[];
const loadServices={loadState,loadedObjects,loaders:[linker],
  read:(object,key)=>{
    if(object===soundClass)return key==='nameIndex'?className:key==='outer'?classOuter:undefined;
    if(object===classOuter)return key==='nameIndex'?classPackage:key==='outer'?null:undefined;
    return object[key];
  },
  resolveName:(outer,name,options)=>resolveNameNative(outer,name,{...options,services:{}}),
  findPackageFile:({filename,guid})=>{
    assert.equal(guid,null);assert.equal(filename,'..\\System\\DeusExConAudioMission00.u');
    return {found:true,path:filename};
  },
  copyString:({source})=>source,
  createPackage:({outer,name})=>{assert.equal(outer,null);assert.equal(name,audio.name);return soundOuter;},
  findName:(text,mode)=>{assert.equal(text,entry.name);assert.equal(mode,1);return objectName;},
  readHashHead:(candidate,bucket)=>{assert.equal(candidate,linker);assert.equal(bucket,(className*7+classPackage*31+objectName)&255);return index-1;},
  readExport:(candidate,number)=>{assert.equal(candidate,linker);assert.equal(number,index-1);return exportRecord;},
  readImportWord:(candidate,offset)=>{
    assert.equal(candidate,linker);
    const record=audio.pkg.imports[Math.floor(offset/0x1c)];assert.ok(record);
    if(offset%0x1c===8)return record.outer;
    assert.equal(offset%0x1c,12);return nameIndex(record.name);
  },
  createExport:({existing})=>{assert.equal(existing,sound);return existing;},
  logReceiver:{},logEndLoad:()=>{},
  reallocLoaded:({num,max,elementSize})=>assert.deepEqual([num,max,elementSize],[0,0,4]),
};
const temporaryFrees=[];
const speechLookup={read:(object,key)=>{
    if(key==='Name'&&object?.kind==='Package')return object.name;
    return read(object,key);
  },write,soundClass,copyString:({source})=>source,
  equalText:(left,right)=>left.toUpperCase()===right.toUpperCase(),
  formatString:({format,args})=>{
    const text=format==='ConAudio%s_%d'?`ConAudio${args[0]}_${args[1]}`:`..\\System\\${args[0]}Audio${args[1]}.u`;
    return {data:text,num:text.length+1,max:text.length+1};
  },
  stringText:data=>data,
  staticLoadObject:request=>{const result=staticLoadObject(request,loadServices);loads.push(result);return result.object;},
  arrayRealloc:(array,size)=>{assert.equal(size,2);assert.equal(array.max,0);},
  arrayRemove:(array,start,count,size)=>assert.deepEqual([start,count,size],[0,0,2]),
  arrayDestroy:array=>{temporaryFrees.push(array.data);array.data=0;array.max=0;array.num=0;},
  allocatorFree:pointer=>temporaryFrees.push(pointer),
};
runtime.conversationLifecycle={audio:{speechLookup,
  read:(object,key)=>object===sound&&key==='soundData'?data:read(object,key),
  loadSpecial:current=>loadSoundDataSpecial(current,{read,write,tell:archiveServices.tell,seek:archiveServices.seek,
    serializeArray:(archive,array)=>{assert.equal(array,data.array);serializeSoundByteArray(data,archive,archiveServices);}}),
  log:()=>assert.fail('Valid MP3 must not warn'),
}};
const conSys=await assets.get('ConSys');
const fn=await runtime.prepareFunction(conSys,conSys.exportsByPath.get('conversation.getspeechlength'));
assert.equal(runtime.callFunction(fn,conversation,1,()=>79),7.176000118255615);
assert.equal(loads.length,1);assert.equal(loads[0].object,sound);
assert.equal(loadState.nest,0);assert.equal(loadedObjects.length,0);
assert.equal(data.lazyField08,-savedPosition);assert.equal(data.array.num,43056);
assert.equal(data.archive,archive);assert.equal(reader.offset,savedCursor);
assert.equal(storage.durationCache,-1,'LoadSpecial does not write the generic period cache');
assert.deepEqual(temporaryFrees,['..\\System\\DeusExConAudioMission00.u','ConAudioMission00_79']);
const bytes=data.array.data;
destroySoundDataLifecycle(data,{detachLazyLoader:(archive,data)=>detachLinkerLazyLoader(archive,data),
  arrayRemove:removeAll,allocatorFree:()=>assert.fail('Remove already released byte storage')});
assert.equal(data.archive,0);assert.equal(data.lazyField08,0);assert.ok(freed.includes(bytes));
assert.equal(archive.lazyLoaderArray.num,0);
console.log('Original DL_Start integration passed: shared2056→GetSpeechAudio→filename linker/export→lazy MP3 storage→7.176000118255615s; cursor, temporary strings and storage cleanup verified.');
