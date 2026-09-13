import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {loadLazyByteArray} from '../src/runtime/script-lazy-byte-array.mjs';
import {loadSoundDataNative} from '../src/runtime/script-sound-load.mjs';
import {serializeSoundHelperLifecycle,serializeSoundByteArray} from '../src/runtime/script-sound-lifecycle.mjs';

const cases=JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-lazy-byte-array-oracle.py',gameDirectory()],{encoding:'utf8'}));
for(const expected of cases){
  const ops=[],archive={position:200,version:68,ar0c:1,ar10:0,serializationFlag:0};
  const data={archive,lazyField08:expected.initial,array:{data:0x2000,num:0,max:0}};
  const owner={soundData:data,serializedByteCount:77,durationCache:-1};data.owner=owner;
  if(expected.kind==='serialize-array'){
    data.array.num=2;data.array.max=9;
    assert.equal(serializeSoundByteArray(data,archive,{
      countBytes:(current,num,max)=>{assert.equal(current,archive);ops.push(['count-bytes',num,max]);data.array.num=3;},
      serializeCompact:(current,holder)=>{assert.equal(current,archive);ops.push(['compact',holder.value]);holder.value=5;},
      arrayRealloc:(array,size)=>{
        assert.equal(array,data.array);assert.equal(size,1);
        ops.push(['realloc',array.num,array.max]);array.data=new Uint8Array(16);array.num=7;
      },
      serializeRaw:(current,holder,width)=>{
        assert.equal(current,archive);assert.equal(holder.value,data.array.data);ops.push(['raw-array',width]);
      },
    }),archive);
    assert.deepEqual(ops,expected.ops);
    assert.equal(data.array.num,expected.count);assert.equal(data.array.max,expected.max);
    continue;
  }
  if(expected.kind==='helper'){
    serializeSoundHelperLifecycle(owner,archive,{
      serializeRaw:(_archive,holder,width)=>{ops.push(['raw',width]);holder.value=0x800;},
      attachLazyLoader:()=>ops.push(['attach']),
      loadSoundData:loaded=>{assert.equal(loaded,data);ops.push(['load']);data.array.num=13;},
      seek:(_archive,position)=>ops.push(['seek',position]),
    });
  }else{
    const loadArray=()=>loadLazyByteArray(data,{
      read:(object,key)=>object[key],
      write:(object,key,value)=>{assert.equal(key,'lazyField08');ops.push(['position',value]);object[key]=value;},
      tell:current=>{assert.equal(current,archive);ops.push(['tell',current.position]);return current.position;},
      seek:(current,position)=>{assert.equal(current,archive);ops.push(['seek',position]);current.position=position;},
      serializeArray:(current,array)=>{
        assert.equal(current,archive);assert.equal(array,data.array);ops.push(['array']);array.num=13;
        if(expected.change)data.lazyField08=160;
      },
    });
    if(expected.kind.startsWith('sound'))loadSoundDataNative(data,{
      read:(o,k)=>o[k],loadArray,
      getPeriod:()=>{ops.push(['period']);return 0.5;},
      readAudio:()=>null,
      write:(object,key,value)=>{
        assert.equal(object,owner);
        const bits=key==='durationCache'?new Uint32Array(new Float32Array([value]).buffer)[0]:value;
        ops.push(['owner-write',key==='durationCache'?0x4c:0x48,bits]);object[key]=value;
      },
    });
    else loadArray();
  }
  assert.deepEqual(ops,expected.ops,`${expected.kind}/${expected.initial}/${expected.change} native order`);
  assert.equal(data.lazyField08,expected.position);
  assert.equal(data.array.num,expected.count);
  assert.equal(owner.serializedByteCount,expected.ownerCount);
  assert.equal(owner.durationCache,expected.ownerDuration);
}
console.log('Original lazy byte-array Load passed signed-position, live reload, archive restore and Sound helper ownership boundaries.');
