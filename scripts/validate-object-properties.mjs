import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {initializeNativeObjectProperties,OBJECT_PROPERTIES_NATIVE} from '../src/runtime/script-object-properties.mjs';
import {gameDirectory} from './game-directory.mjs';

const original=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON??path.resolve('.cache/native-probe-env/bin/python'),
  ['scripts/native-object-properties-oracle.py',gameDirectory()],{encoding:'utf8'}));
assert.equal(original.hashes['Core.dll'],OBJECT_PROPERTIES_NATIVE.coreSha256);
for(const mode of ['explicit','fallback','empty']){
  const data=new Uint8Array(0x40).fill(0xa5), source=Uint8Array.from({length:0x40},(_,i)=>i);
  const property=new Map([[0x48,0x2c],[0x38,4],[0x34,1]]);
  property.set(0x54,property);
  const cls=new Map([[0x4d4,source],[0x4d8,mode==='fallback'?0x30:0],[0x68,mode==='fallback'?property:null]]);
  const callbacks=[];
  initializeNativeObjectProperties({data,count:0x40,cls,defaults:mode==='explicit'?source:null,
    propertySize:mode==='explicit'?0x35:0x40},{
    read:(object,offset)=>object.get(offset),
    copyCompleteValue:({destination,source})=>{
      const dst=new DataView(destination.bytes.buffer),src=new DataView(source.bytes.buffer);
      callbacks.push({before:dst.getUint32(destination.offset,true),source:src.getUint32(source.offset,true)});
      dst.setUint32(destination.offset,src.getUint32(source.offset,true),true);
      // The translated list must reread Next after the synchronous copy call.
      property.set(0x54,null);
    },
  });
  assert.deepEqual([...data],original.cases[mode].bytes,mode+' unchanged native bytes');
  assert.deepEqual(callbacks,original.cases[mode].callbacks,mode+' owning copy after zero');
}
console.log('InitProperties matches original Core: explicit template, class-default fallback, empty tail, header preservation and owning-copy zeroing.');
