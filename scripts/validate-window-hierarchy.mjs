import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {getRootWindowNative,addWindowChildNative} from '../src/runtime/script-window-hierarchy.mjs';
import {gameDirectory} from './game-directory.mjs';

const native=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON||'.cache/native-probe-env/bin/python',
  ['scripts/native-window-hierarchy-oracle.py',gameDirectory()],{encoding:'utf8'}));
for(const [name,start,type] of [['childRoot',0,3],['rootSelf',2,3],['nonRoot',0,2],['highByte',0,255]]){
  const objects=[{},{},{type}],reads=[];
  const result=getRootWindowNative(objects[start],{
    readParent:object=>{const index=objects.indexOf(object);reads.push({object:index,offset:0x138,size:4});return objects[index+1]??null;},
    readType:object=>{reads.push({object:objects.indexOf(object),offset:0x28,size:1});return object.type;},
  });
  assert.deepEqual({result:result===null?null:objects.indexOf(result),reads},native.cases[name],name);
}
for(const [name,original] of Object.entries(native.links)){
  const objects=original.before.map(()=>({})),events=[];
  for(const [index,fields] of original.before.entries())for(const [field,value] of fields.entries())
    objects[index][0x138+field*4]=value===null?null:objects[value];
  const identity=value=>value===null?null:objects.indexOf(value);
  addWindowChildNative(objects[original.parent],objects[original.child],original.front,{
    read:(object,offset)=>{
      const value=object[offset];events.push({op:'read',object:identity(object),offset,value:identity(value)});return value;
    },
    write:(object,offset,value)=>{
      events.push({op:'write',object:identity(object),offset,value:identity(value)});object[offset]=value;
    },
  });
  assert.deepEqual(events,original.events,name+' read/write order');
  assert.deepEqual(objects.map(object=>[0x138,0x13c,0x140,0x144,0x148].map(offset=>identity(object[offset]))),
    original.after,name+' final hierarchy');
}
console.log('Window hierarchy matches original root traversal/type gate and child insertion/reparenting pointer read/write order.');
