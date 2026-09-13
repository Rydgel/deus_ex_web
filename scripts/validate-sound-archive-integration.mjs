import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {Reader} from '../src/unreal/package.mjs';
import {gameDirectory} from './game-directory.mjs';
import {constructSoundNative} from '../src/runtime/script-sound-construction.mjs';
import {serializeSoundHelperLifecycle,serializeSoundByteArray,destroySoundDataLifecycle} from '../src/runtime/script-sound-lifecycle.mjs';
import {createLinkerLoadArchive,attachLinkerLazyLoader,detachLinkerLazyLoader} from '../src/runtime/script-linker-lazy-loader.mjs';
import {loadLazyByteArray} from '../src/runtime/script-lazy-byte-array.mjs';
import {loadSoundDataNative} from '../src/runtime/script-sound-load.mjs';
import {getPeriod} from '../src/runtime/script-sound-period.mjs';

const root=gameDirectory(),filename=root+'/System/DeusExSounds.u';
const assets=new AssetStore([{path:filename,read:()=>readFile(filename)}]);
const asset=await assets.get('DeusExSounds');
const entry=asset.pkg.exports[asset.exportsByPath.get('special.switch4clickon')-1];
const reader=new Reader(asset.bytes);reader.offset=entry.serialOffset;
assert.equal(asset.pkg.names[reader.compact()].name,'None');
assert.equal(asset.pkg.names[reader.compact()].name,'wav');
const helperStart=reader.offset;
const freed=[];
const realloc=(array,size)=>{
  const old=array.data;
  if(array.max===0){if(old!==null)freed.push(old);array.data=null;return;}
  assert.equal(old,null,'selected fixture reallocates only empty arrays');
  array.data=size===1?new Uint8Array(array.max):Array(array.max).fill(null);
};
const removeAll=(array,index,count,size)=>{
  assert.equal(index,0);assert.equal(count,array.num);
  // This fixture reaches only native Remove's all-elements shrink case.
  array.num=0;array.max=0;realloc(array,size);
};
const archive=createLinkerLoadArchive({linker:{package:asset},reader:{tell:()=>reader.offset},
  services:{arrayRealloc:realloc,arrayRemove:removeAll,
    log:()=>{throw new Error('Unexpected detachment mismatch');}}});
Object.assign(archive,{version:asset.pkg.version,ar0c:1,ar10:0,serializationFlag:1});
const sound={serializedByteCount:0};constructSoundNative(sound,{arrayRealloc:realloc});
const data=sound.soundData;
const services={
  attachLazyLoader:(current,loader)=>attachLinkerLazyLoader(current,loader),
  tell:current=>{assert.equal(current,archive);return reader.offset;},
  seek:(current,position)=>{assert.equal(current,archive);assert.ok(position>=0&&position<=asset.bytes.length);reader.offset=position;},
  countBytes:(current,num,max)=>{assert.equal(current,archive);assert.equal(num,0);assert.equal(max,0);},
  serializeCompact:(current,holder)=>{assert.equal(current,archive);holder.value=reader.compact();},
  serializeRaw:(current,holder,width)=>{
    assert.equal(current,archive);
    if(holder.value instanceof Uint8Array){assert.equal(width,holder.value.length);holder.value.set(reader.take(width));}
    else{assert.equal(width,4);holder.value=reader.u32();}
  },
  arrayRealloc:realloc,
};
serializeSoundHelperLifecycle(sound,archive,services);
assert.equal(data.archive,archive);
assert.equal(data.lazyField08,helperStart+4,'Attach Tell points at compact byte count');
assert.equal(data.array.num,0);
assert.equal(reader.offset,entry.serialOffset+entry.serialSize);
assert.equal(archive.lazyLoaderArray.data[0],data);
const loadArray=()=>loadLazyByteArray(data,{read:(o,k)=>o[k],write:(o,k,v)=>{o[k]=v;},
  tell:services.tell,seek:services.seek,
  serializeArray:(current,array)=>{assert.equal(array,data.array);serializeSoundByteArray(data,current,services);}});
const write=(o,k,v)=>{o[k]=v;};
loadSoundDataNative(data,{read:(o,k)=>o[k],write,loadArray,
  getPeriod:value=>getPeriod(value,{lazyLoad:loadArray}),readAudio:()=>null});
assert.equal(data.lazyField08,-(helperStart+4));
assert.equal(data.archive,archive,'successful load retains archive attachment');
assert.equal(reader.offset,entry.serialOffset+entry.serialSize,'saved file cursor restored');
assert.equal(sound.serializedByteCount,11238);
assert.equal(sound.durationCache,0.2521088421344757);
const loadedBytes=data.array.data;
assert.deepEqual(loadedBytes,new Uint8Array(asset.bytes.subarray(entry.serialOffset+entry.serialSize-11238,entry.serialOffset+entry.serialSize)));
destroySoundDataLifecycle(data,{
  detachLazyLoader:(current,loader)=>detachLinkerLazyLoader(current,loader),
  arrayRemove:removeAll,
  allocatorFree:()=>{throw new Error('Remove already freed selected zero-size allocation');},
});
assert.equal(data.archive,0);assert.equal(data.lazyField08,0);
assert.deepEqual(data.array,{data:0,num:0,max:0});
assert.equal(archive.lazyLoaderArray.num,0);
assert.equal(freed.length,2);assert.equal(freed[1],loadedBytes);
console.log('Original Switch4ClickOn archive composition passed: attach, lazy bytes, native period, owner fields, cursor restore, detach and allocation service release.');
