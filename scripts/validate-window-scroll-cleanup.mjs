/** Compare Scale owning-member images/releases; verify inherited family routes. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {cleanScaleMembers,destroyScaleMembers} from '../src/runtime/script-window-scroll-cleanup.mjs';
const cases=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-window-scroll-cleanup-oracle.py',gameDirectory()],{encoding:'utf8',maxBuffer:1<<22}));
for(const c of cases){
 const memory=new Map([[c.object,Buffer.from(c.before,'hex')]]),events=[],ids=new Map();
 if(c.data)memory.set(c.data,Buffer.from(c.arrayBefore,'hex'));
 const W={u32:(o,k)=>memory.get(o).readUInt32LE(k),i32:(o,k)=>memory.get(o).readInt32LE(k),heap:{write:()=>{}},farray:{},boundary:message=>{throw Error(message);}};
 W.farray.empty=(o,k,size)=>{
  assert.ok(size===2||size===12);const old=W.u32(o,k);
  if(old&&!ids.has(old))ids.set(old,'a'+ids.size);
  events.push({op:'Realloc',old:old?ids.get(old):0,size:0,tag:'FArray',block:0});memory.get(o).fill(0,k,k+12);
 };
 if(c.family==='scale')(c.mode==='cleanup'?cleanScaleMembers:destroyScaleMembers)(W,c.object);
 const expected=Buffer.from(c.after,'hex');
 // The host's base destructor dispatch owns vtable changes, not these members.
 if(c.mode==='destructor')expected.writeUInt32LE(0,0);
 assert.equal(memory.get(c.object).toString('hex'),expected.toString('hex'),c.family+'/'+c.mode+' object');
 if(c.data)assert.equal(memory.get(c.data).toString('hex'),c.arrayAfter,'label headers');
 assert.deepEqual(events,c.events,c.family+'/'+c.mode+' ordered container releases');
 if(c.mode==='cleanup')assert.deepEqual(c.calls.map(x=>x.op),[c.family==='clip'?'TabGroup.CleanUp':'Window.CleanUp']);
 else{
  assert.deepEqual(c.calls.map(x=>x.op),[...Array(c.family==='clip'?4:3).fill('ConditionalDestroy'),'ObjectDestructor']);
  assert.deepEqual(c.calls.slice(-3).map(x=>x.vtable),[0x12059930,0x12059888,0x12059888]);
 }
}
console.log(`window-scroll-cleanup: ${cases.length} original cleanup/destructor cases match member images, releases and base routes`);
