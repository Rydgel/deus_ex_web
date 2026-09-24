/** Compare original ScrollArea bodies, complete images and service order. */
import {dispatchWindowHostNative} from '../src/runtime/script-window-host-natives.mjs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {constructScrollAreaWindow,initScrollAreaWindow,enableScrollAreaScrolling} from '../src/runtime/script-window-scroll-area.mjs';
const python=process.env.NATIVE_PROBE_PYTHON;
assert.ok(python,'Set NATIVE_PROBE_PYTHON to the Unicorn environment');
const cases=JSON.parse(execFileSync(python,['scripts/native-window-scroll-area-oracle.py',gameDirectory()],{encoding:'utf8',maxBuffer:1<<24}));
const floatBits=value=>{const b=Buffer.alloc(4);b.writeFloatLE(value);return b.readUInt32LE();};
for(const original of cases){
  const memory=new Map(original.images.map(image=>[image.address,Buffer.from(image.before,'hex')])),events=[];
  const record=op=>(object,...args)=>events.push({op,object,args});
  const W={ptr:(o,off)=>memory.get(o).readUInt32LE(off),u32:(o,off)=>memory.get(o).readUInt32LE(off),
    setPtr:(o,off,v)=>memory.get(o).writeUInt32LE(v,off),
    setU32:(o,off,v)=>memory.get(o).writeUInt32LE(v>>>0,off),
    setF32:(o,off,v)=>memory.get(o).writeFloatLE(v,off),native:{},
    uobjectConstructor:record('uobjectConstructor'),initWindow:record('initWindow')};
  for(const name of ['askParentForReconfigure','setScaleButtons','setScale','setOrientation',
    'setSelectability','setNumTicks','setThumbSpan','enableStretchedScale','forceChildSize'])W.native[name]=record(name);
  W.native.enableAutoRepeat=(o,on,delay,rate)=>record('enableAutoRepeat')(o,on,floatBits(delay),floatBits(rate));
  W.native.setVisibility=(o,on)=>{
    record('setVisibility')(o,on);
    if(original.mutate){W.setPtr(original.this,0x150,0);W.setPtr(original.this,0x16c,0);}
  };
  const children=original.images.filter(image=>image.name.startsWith('child'));
  let next=0;
  W.createNewWindow=(className,parent,flag)=>{
    const result=children[next++].address;
    events.push({op:'createNewWindow',className,parent,flag,result});return result;
  };
  if(original.mode==='ctor')constructScrollAreaWindow(W,original.this);
  else if(original.mode==='init')initScrollAreaWindow(W,original.this,original.parent);
  else if((original.seed&3)===3)dispatchWindowHostNative(W,{index:1700,receiver:original.this,argumentCount:0,evaluateArgument:()=>undefined});
  else enableScrollAreaScrolling(W,original.this,original.seed&1,(original.seed>>1)&1);
  assert.deepEqual(events,original.events,`${original.mode}/${original.seed} service calls`);
  for(const image of original.images)assert.equal(memory.get(image.address).toString('hex'),image.after,`${original.mode}/${original.seed} ${image.name}`);
}
console.log(`window-scroll-area: ${cases.length} original constructor/Init/EnableScrolling body comparisons pass; child services remain explicit`);
