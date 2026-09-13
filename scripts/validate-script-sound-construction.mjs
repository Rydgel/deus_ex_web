import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {constructSoundNative} from '../src/runtime/script-sound-construction.mjs';

const python=process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python';
const original=JSON.parse(execFileSync(python,['scripts/native-script-sound-construction-oracle.py',gameDirectory()],{encoding:'utf8'}));
const sound={formatName:21,serializedByteCount:23,durationCache:0x12345678,copyField:25,
  soundData:{archive:0xa5a5a5a5}};
const events=[];
constructSoundNative(sound,{arrayRealloc:(array,elementSize)=>{
  assert.equal(array,sound.soundData.array);
  events.push({arrayOffset:0x34,elementSize,array:[array.data??0,array.num,array.max],
    soundVtable:sound.nativeVtable,external:sound.soundData.archive});
}});
assert.equal(sound.nativeVtable,original.vtable);
assert.deepEqual([sound.soundData.nativeVtable,sound.soundData.archive??0,sound.soundData.lazyField08,
  sound.soundData.array.data??0,sound.soundData.array.num,sound.soundData.array.max],original.soundData);
assert.equal(sound.soundData.owner===sound,original.ownerIsSelf);
assert.equal(sound.formatName,original.format);assert.equal(sound.serializedByteCount,original.byteCount);
assert.equal(sound.durationCache,original.duration);assert.equal(sound.copyField,original.tail);
assert.deepEqual(events,original.events);
console.log('Original USound constructor call order, embedded array, owner/vtables and preserved template words passed.');
