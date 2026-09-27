/** Same heap bytes and ordered GC/script leaves against original Extension.dll. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {runChildWithWatchdog} from './training-probe-lib.mjs';
import * as C from '../src/runtime/script-window-computer-playback.mjs';
if(!process.argv.includes('--child')){
  const result=await runChildWithWatchdog({script:fileURLToPath(import.meta.url),args:[],out:'.cache/computer-playback-validation.json',capMiB:2048,label:'computer-playback'});
  console.log(`window-computer-playback: ${result.data.cases} original same-heap comparisons pass (${result.peakMiB} MiB peak RSS)`);
}else{
  const native=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',[
    'scripts/native-window-computer-playback-oracle.py',gameDirectory()],{encoding:'utf8',maxBuffer:16<<20}));
  assert.equal(native.hash,'93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c');
  for(const c of native.cases){
    const bytes=Buffer.from(c.before,'hex'),events=[];
    const read=(p,k)=>{const o=p-c.base;switch(k){case 'f32':return bytes.readFloatLE(o);case 'i32':return bytes.readInt32LE(o);case 'u16':return bytes.readUInt16LE(o);case 'u8':return bytes.readUInt8(o);default:return bytes.readUInt32LE(o);}};
    const write=(p,k,v)=>{const o=p-c.base;switch(k){case 'f32':bytes.writeFloatLE(v,o);break;case 'i32':bytes.writeInt32LE(v|0,o);break;case 'u16':bytes.writeUInt16LE(v&65535,o);break;case 'u8':bytes.writeUInt8(v&255,o);break;default:bytes.writeUInt32LE(v>>>0,o);}};
    const W={heap:{mem:{read,write},copyBytes:(a,b,size)=>bytes.copy(bytes,a-c.base,b-c.base,b-c.base+size),freeRaw:()=>{}},gc:{services:{}},computerPauser:()=>c.paused?'Paused':'',boundary:m=>{throw Error(m);}};
    for(const [name,kind] of [['u8','u8'],['u16','u16'],['u32','u32'],['i32','i32'],['f32','f32'],['ptr','ptr']]){
      W[name]=(o,k)=>read(o+k,kind);W['set'+name[0].toUpperCase()+name.slice(1)]=(o,k,v)=>write(o+k,kind,v);
    }
    W.processScript=(object,op,args)=>{events.push({op,object,args});return op==='ComputerStart'&&object===c.parent;};
    W.farray={
      add:(o,k,count,size)=>{const num=read(o+k+4,'i32');if(num+count>read(o+k+8,'i32')){write(o+k,'u32',c.base+0x2400);write(o+k+8,'i32',num+count+Math.trunc(3*(num+count)/8)+32);}write(o+k+4,'i32',num+count);return num;},
      remove:(o,k,index,count,size)=>{const p=read(o+k,'u32'),num=read(o+k+4,'i32');W.heap.copyBytes(p+index*size,p+(index+count)*size,(num-index-count)*size);write(o+k+4,'i32',num-count);},
      empty:(o,k)=>{write(o+k,'u32',0);write(o+k+4,'u32',0);write(o+k+8,'u32',0);},
    };
    const ops=Object.fromEntries(Object.keys(C.COMPUTER_DRAW_OPS).map(op=>[op,(object,...args)=>{args.pop();events.push({op,object,args});}]));
    if(c.mode==='draw')C.computerDraw(W,c.base,c.gc,ops);
    else ({tick:C.computerTick,visibility:C.computerVisibilityChanged,queue:C.computerProcessQueue,scroll:C.computerScroll,cleanup:C.computerCleanUp}[c.mode])(W,c.base,...c.args);
    assert.deepEqual(events,c.events,c.name+' ordered leaves');
    const expected=Buffer.from(c.after,'hex');
    const diff=[];for(let i=0;i<bytes.length;i++)if(bytes[i]!==expected[i])diff.push('+'+i.toString(16)+': '+bytes[i].toString(16)+' != '+expected[i].toString(16));
    assert.equal(diff.length,0,c.name+' heap: '+diff.slice(0,20).join(', '));
  }
  writeFileSync(process.argv[process.argv.indexOf('--out')+1],JSON.stringify({cases:native.cases.length}));
}
