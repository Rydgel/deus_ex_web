import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {setWindowConfigurationNative} from '../src/runtime/script-window-configuration.mjs';
import {gameDirectory} from './game-directory.mjs';
const bytes=new ArrayBuffer(4),view=new DataView(bytes);
const bits=x=>{view.setFloat32(0,x,true);return view.getUint32(0,true);};
const float=x=>{view.setUint32(0,x,true);return view.getFloat32(0,true);};
const base=[10,20,30,40],offsets=[0x8c,0x94,0x9c,0xa0];
const specs=[{args:base},{args:[11,20,30,40]},{args:[10,21,30,40]},
 {args:[10,20,31,40]},{args:[10,20,30,41]},{args:base,align:1},
 {args:[0,0,-5,-10]},{args:[10,20,NaN,NaN]},{args:[NaN,20,30,40]},
 {args:[-0,-0,0,0],initial:[0,0,0,0]}];
const cases=specs.map(s=>({initial:[[0x88,s.align??0],[0x89,0],...offsets.map((off,i)=>[off,bits((s.initial??base)[i])])],args:s.args.map(bits)}));
const original=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
 ['scripts/native-window-configuration-oracle.py',gameDirectory()],{input:JSON.stringify(cases),encoding:'utf8'}));
for(const [i,c] of cases.entries()){
 const memory=new DataView(new ArrayBuffer(0x200)),object={},events=[];
 for(const [offset,b] of c.initial)offset<0x8c?memory.setUint8(offset,b):memory.setUint32(offset,b,true);
 setWindowConfigurationNative(object,...c.args.map(float),{
  read:(_o,off,kind)=>kind==='u8'?memory.getUint8(off):memory.getFloat32(off,true),
  write:(_o,off,kind,v)=>kind==='u8'?memory.setUint8(off,v):memory.setFloat32(off,v,true),
  askParentForReconfigure:()=>events.push({op:'AskParentForReconfigure'}),
 });
 assert.deepEqual({storage:Buffer.from(memory.buffer).toString('hex'),events},original[i],`native configuration case ${i}`);
}
console.log('Window.SetConfiguration: 10 original DLL comparisons passed (full storage and one-call/early-return behavior).');
