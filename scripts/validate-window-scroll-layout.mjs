/** Full original preferred-size bodies with byte images and script-service ordering. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import * as L from '../src/runtime/script-window-scroll-layout.mjs';
const python=process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python';
const cases=JSON.parse(execFileSync(python,['scripts/native-window-scroll-layout-oracle.py',gameDirectory()],{encoding:'utf8',maxBuffer:1<<24}));
for(const c of cases){
  const memory=new Map(c.images.map(i=>[i.address,Buffer.from(i.before,'hex')]));
  const nodes=new Map(c.images.map(i=>[i.address,i.node])),events=[],globals=new Map([['preferredSizeDepth',0]]);
  const mem=o=>memory.get(o);
  const service=(op,object,args)=>{
    events.push({op,object,args});const node=nodes.get(object);
    let [width,height]=node.preferred??[23,29];
    if(node.wrap&&args[0])[width,height]=[args[1],args[1]<90?100:40];
    if(node.oscillate&&args[0])[width,height]=[args[1],args[1]<90?40:120];
    return {width,height};
  };
  const W={
    u8:(o,off)=>mem(o).readUInt8(off),u32:(o,off)=>mem(o).readUInt32LE(off),i32:(o,off)=>mem(o).readInt32LE(off),
    f32:(o,off)=>mem(o).readFloatLE(off),ptr:(o,off)=>mem(o).readUInt32LE(off)||null,
    setU32:(o,off,v)=>mem(o).writeUInt32LE(v>>>0,off),setF32:(o,off,v)=>mem(o).writeFloatLE(v,off),
    global:name=>globals.get(name),setGlobal:(name,v)=>globals.set(name,v),boundary:message=>{throw Error(message);},
    processScript:(object,event,args)=>{assert.equal(event,'ParentRequestedGranularity');events.push({op:'baseGranularity',object,args:[...args]});const units=nodes.get(object).units??[2,3];args[0]=units[0];args[1]=units[1];},
    native:{tabGroupPreferredSize:(o,...args)=>service('tabGroup',o,args)},
    v:{parentRequestedPreferredSize:(o,...args)=>{
      const fn={scale:L.scalePreferredSize,manager:L.managerPreferredSize,clip:L.clipPreferredSize,scroll:L.scrollAreaPreferredSize}[nodes.get(o).kind];
      return fn?fn(W,o,...args):service('preferred',o,args);
    },
      parentRequestedGranularity:o=>{events.push({op:'granularity',object:o,args:[]});const [h,v]=nodes.get(o).units??[2,3];return {h,v};}},
  };
  const fn={scale:L.scalePreferredSize,manager:L.managerPreferredSize,clip:L.clipPreferredSize,queryClip:L.queryClipPreferredSize,scroll:L.scrollAreaPreferredSize}[c.mode];
  const gran=c.mode==='tileGran'?L.tileGranularity(W,c.root,c.args[1],c.args[3]):null;
  const result=gran?{width:gran.h,height:gran.v}:fn(W,c.root,...c.args),output=Buffer.alloc(16);
  output.writeFloatLE(result.width,0);output.writeFloatLE(result.height,4);
  output.writeUInt32LE(result.overflowW??0,8);output.writeUInt32LE(result.overflowH??0,12);
  assert.equal(output.toString('hex'),c.out,`${c.name} output ${JSON.stringify(result)}`);
  for(const i of c.images){
    const expected=Buffer.from(i.after,'hex'),got=mem(i.address),diff=[];
    for(let off=0;off<got.length;off++)if(got[off]!==expected[off])diff.push(`+${off.toString(16)} ${got[off].toString(16)} != ${expected[off].toString(16)}`);
    assert.equal(diff.length,0,`${c.name} ${i.address.toString(16)}: ${diff.slice(0,8).join(', ')}`);
  }
  assert.deepEqual(events,c.events,`${c.name} query ordering`);
  assert.equal(globals.get('preferredSizeDepth'),0);
}
console.log(`window-scroll-layout: ${cases.length} original preferred-size chains match output, full memory and query order`);
