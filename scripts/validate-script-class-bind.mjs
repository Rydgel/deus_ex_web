import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {bindScriptClassConstructor} from '../src/runtime/script-class-bind.mjs';

const python=process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python';
const original=JSON.parse(execFileSync(python,['scripts/native-script-class-bind-oracle.py',gameDirectory()],{encoding:'utf8'}));
const coreObject={};
let visits=[],writes=[],editor=false;
function cls(name,base,objectFlags,pointer){
  return {name,base,objectFlags,get nativeConstructor(){return pointer;},
    set nativeConstructor(value){pointer=value;writes.push([name,value??0]);}};
}
const actor=cls('Actor',coreObject,0x040f0004,0x10302dab);
const base=cls('ConPlayBase',actor,0x000f0004,null);
const child=cls('DataLinkPlay',base,0x000f0004,null);
const binding=new Set();
function bind(record){
  if(binding.has(record))throw new Error('Cyclic class inheritance');
  binding.add(record);visits.push(record.name);
  try{bindScriptClassConstructor(record,{coreObject,isEditor:()=>editor,bindSuper:bind});}
  finally{binding.delete(record);}
}
bind(child);
assert.deepEqual({visits,writes,constructors:[actor,base,child].map(c=>c.nativeConstructor)},original.first);
visits=[];writes=[];bind(child);
assert.deepEqual({visits,writes},original.repeat);
visits=[];writes=[];editor=true;
const incomplete=cls('EditorClass',null,0,null);bind(incomplete);
assert.deepEqual({visits,writes,constructor:incomplete.nativeConstructor??0},original.editor);
console.log('Original Core UClass.Bind passed recursive constructor stores, repeated binding, and editor null-constructor case.');
