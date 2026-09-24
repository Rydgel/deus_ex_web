/** Compare original complete movement chains and ordered service boundaries. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import * as M from '../src/runtime/script-window-scroll-movement.mjs';
import * as Input from '../src/runtime/script-window-scroll-input.mjs';
import * as C from '../src/runtime/script-window-scroll-configuration.mjs';
const cases=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-window-scroll-movement-oracle.py',gameDirectory()],{encoding:'utf8',maxBuffer:1<<25}));
for(const c of cases){
 const mem=new Map(c.images.map(i=>[i.address,Buffer.from(i.before,'hex')])),nodes=new Map(c.images.map(i=>[i.address,i.node])),events=[];
 let context=0x13572468;
 const W={u8:(o,k)=>mem.get(o).readUInt8(k),u32:(o,k)=>mem.get(o).readUInt32LE(k),i32:(o,k)=>mem.get(o).readInt32LE(k),f32:(o,k)=>mem.get(o).readFloatLE(k),ptr:(o,k)=>mem.get(o).readUInt32LE(k)||null,
  setU8:(o,k,v)=>mem.get(o).writeUInt8(v&255,k),setI32:(o,k,v)=>mem.get(o).writeInt32LE(v|0,k),setU32:(o,k,v)=>mem.get(o).writeUInt32LE(v>>>0,k),setF32:(o,k,v)=>mem.get(o).writeFloatLE(v,k),setPtr:(o,k,v)=>mem.get(o).writeUInt32LE(v??0,k),
  global:()=>context,setGlobal:(_,v)=>{context=v;},native:{},v:{}};
 W.processScript=(object,op,args)=>{
  events.push({op,object,args:args.map(a=>a??0)});
  for(const [off,v] of Object.entries(nodes.get(object).mutate??{})){
   const value=typeof v==='string'?c.addresses[v]:v;
   W.setU32(object,Number(off),value);
  }
  return Boolean(nodes.get(object).handled);
 };
 const kind=o=>nodes.get(o).kind;
 W.v.scaleRangeChanged=(o,...args)=>kind(o)==='scroll'?M.scrollScaleRange(W,o,...args):W.processScript(o,'ScaleRangeChanged',args);
 W.v.scalePositionChanged=(o,...args)=>kind(o)==='manager'?M.managerScalePosition(W,o,...args):W.processScript(o,'ScalePositionChanged',args);
 W.v.clipPositionChanged=(o,...args)=>kind(o)==='scroll'?M.scrollClipPosition(W,o,...args):W.processScript(o,'ClipPositionChanged',args);
 W.v.scaleAttributesChanged=(o,...args)=>kind(o)==='manager'?C.managerScaleAttributes(W,o,...args):W.processScript(o,'ScaleAttributesChanged',args);
 W.native.changeScalePosition=(o,n)=>M.changeScalePosition(W,o,n);
 W.native.configureChild=(object,...args)=>{events.push({op:'configure',object,args,context});args.forEach((v,i)=>W.setF32(object,0x78+4*i,v));};
 W.native.setSensitivity=(object,v)=>events.push({op:'sensitivity',object,args:[Number(v)]});
 W.tickOffset=()=>{events.push({op:'tickOffset',object:c.root,args:[]});return nodes.get(c.root).tickOffset??0.125;};
 W.native.playSound=(object,...args)=>events.push({op:'sound',object,args:args.map(v=>v??0)});
 W.native.getCursorPos=object=>{if(nodes.get(object).nativeCursor)return Input.getCursorPos(W,object);events.push({op:'cursor',object,args:[]});const [x,y]=nodes.get(object).cursor??[75,5];return {x,y};};
 W.native.getScaleValueString=()=>{throw Error('Unrecovered value-string boundary');};
 const fn={press:Input.scaleMousePressed,drag:Input.scaleMouseMoved,release:Input.scaleMouseReleased,repeat:Input.scaleTick,pixel:Input.pixelToTick,move:M.moveThumb,tickPosition:M.setTickPosition,change:M.changeScalePosition,clipPosition:M.setClipPosition,button:M.managerButtonActivated,wheel:M.scrollMousePressed,range:M.scrollScaleRange,clipEvent:M.scrollClipPosition,managerPosition:M.managerScalePosition}[c.mode];
 const result=fn(W,c.root,...c.args);
 if(['button','wheel','range','clipEvent','managerPosition','press','release','pixel'].includes(c.mode))assert.equal(Number(result),c.result,c.name+' result');
 assert.deepEqual(events,c.events,c.name+' events');assert.equal(context,c.context,c.name+' context');
 for(const i of c.images)assert.equal(mem.get(i.address).toString('hex'),i.after,c.name+' image '+i.address);
}
console.log(`window-scroll-movement: ${cases.length} original movement-chain comparisons pass`);
