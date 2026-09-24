/** Original configuration bodies, full images and ordered placement/callback services. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import * as C from '../src/runtime/script-window-scroll-configuration.mjs';
import * as L from '../src/runtime/script-window-scroll-layout.mjs';
const python=process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python';
const cases=JSON.parse(execFileSync(python,['scripts/native-window-scroll-configuration-oracle.py',gameDirectory()],{encoding:'utf8',maxBuffer:1<<24}));
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
    setI32:(o,off,v)=>mem(o).writeInt32LE(v|0,off),
    setU32:(o,off,v)=>mem(o).writeUInt32LE(v>>>0,off),setF32:(o,off,v)=>mem(o).writeFloatLE(v,off),
    global:name=>globals.get(name),setGlobal:(name,v)=>globals.set(name,v),boundary:message=>{throw Error(message);},
    processScript:(object,event,args)=>{if(event==='ClipAttributesChanged'||event==='ScaleAttributesChanged'){events.push({op:event==='ClipAttributesChanged'?'clipScript':'scaleScript',object,args});return Boolean(nodes.get(object).scriptHandled);}
      assert.equal(event,'ParentRequestedGranularity');events.push({op:'baseGranularity',object,args:[...args]});const units=nodes.get(object).units??[2,3];args[0]=units[0];args[1]=units[1];},
    native:{setSensitivity:(object,on)=>events.push({op:'sensitivity',object,args:[on?1:0]}),tabGroupPreferredSize:(o,...args)=>service('tabGroup',o,args),
      configureChild:(object,...args)=>{events.push({op:'configure',object,args});if(nodes.get(object).hideOnConfigure)W.setU32(W.ptr(object,0x114),0x30,0);}},
    v:{scaleAttributesChanged:(object,...args)=>nodes.get(object).kind==='manager'?C.managerScaleAttributes(W,object,...args):W.processScript(object,'ScaleAttributesChanged',args),clipAttributesChanged:(object,...args)=>{if(nodes.get(object).kind==='scroll')return C.scrollClipAttributes(W,object,...args);events.push({op:'clipAttributes',object,args});return nodes.get(object).consume?1:0;},
      parentRequestedPreferredSize:(o,...args)=>{
      const fn={scale:L.scalePreferredSize,manager:L.managerPreferredSize,clip:L.clipPreferredSize,scroll:L.scrollAreaPreferredSize}[nodes.get(o).kind];
      return fn?fn(W,o,...args):service('preferred',o,args);
    },
      parentRequestedGranularity:o=>{events.push({op:'granularity',object:o,args:[]});const [h,v]=nodes.get(o).units??[2,3];return {h,v};}},
  };
  const fn={scrollConfig:C.scrollAreaConfiguration,managerConfig:C.managerConfiguration,scaleConfig:C.scaleConfiguration,clipConfig:C.clipConfiguration}[c.mode];
  fn(W,c.root);
  for(const i of c.images){
    const expected=Buffer.from(i.after,'hex'),got=mem(i.address),diff=[];
    for(let off=0;off<got.length;off++)if(got[off]!==expected[off])diff.push(`+${off.toString(16)} ${got[off].toString(16)} != ${expected[off].toString(16)}`);
    assert.equal(diff.length,0,`${c.name} ${i.address.toString(16)}: ${diff.slice(0,8).join(', ')}`);
  }
  assert.deepEqual(events,c.events,`${c.name} query ordering`);
  assert.equal(globals.get('preferredSizeDepth'),0);
}
console.log(`window-scroll-configuration: ${cases.length} original configuration chains match, full memory and query order`);
