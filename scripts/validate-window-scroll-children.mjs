/** Original child-family bodies compared to shared translations before Play admission. */
import {dispatchWindowHostNative} from '../src/runtime/script-window-host-natives.mjs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import * as C from '../src/runtime/script-window-scroll-children.mjs';
const python=process.env.NATIVE_PROBE_PYTHON;assert.ok(python,'Set NATIVE_PROBE_PYTHON');
const cases=JSON.parse(execFileSync(python,['scripts/native-window-scroll-children-oracle.py',gameDirectory()],{encoding:'utf8',maxBuffer:1<<24}));
for(const c of cases){
  const data=Buffer.from(c.before,'hex'),calls=[],strings=new Map();
  const memory=new Map([[c.object,data],...Object.entries(c.extra??{}).map(([o,hex])=>[Number(o),Buffer.from(hex,'hex')])]);
  const mem=o=>memory.get(o);
  const rec=op=>(object,...args)=>calls.push({op,object,args});
  const W={addressOf:o=>o,uobjectConstructor:rec('uobjectConstructor'),initWindow:rec('initWindow'),initTabGroup:rec('initTabGroup'),
    u8:(o,off)=>mem(o).readUInt8(off),u32:(o,off)=>mem(o).readUInt32LE(off),i32:(o,off)=>mem(o).readInt32LE(off),
    ptr:(o,off)=>mem(o).readUInt32LE(off)||null,f32:(o,off)=>mem(o).readFloatLE(off),
    setPtr:(o,off,v)=>mem(o).writeUInt32LE(v??0,off),
    setU8:(o,off,v)=>mem(o).writeUInt8(v,off),setU32:(o,off,v)=>mem(o).writeUInt32LE(v>>>0,off),
    setI32:(o,off,v)=>mem(o).writeInt32LE(v|0,off),setF32:(o,off,v)=>mem(o).writeFloatLE(v,off),
    heap:{write:(o,off,kind,text)=>{assert.equal(kind,'string');strings.set(off,text);}},
    native:{changeScalePosition:rec('changeScalePosition'),askParentForReconfigure:rec('askParentForReconfigure')},
    v:{scaleAttributesChanged:()=>{throw Error('Unexpected visible attribute callback');}}};
  if(c.mode==='ctor')C.constructScrollChild(W,c.object,c.family);
  else if(c.mode==='init')({manager:C.initScaleManager,clip:C.initClip,scale:C.initScale}[c.family])(W,c.object,c.parent);
  else if(c.method===0x3de40&&c.args[0]===1)dispatchWindowHostNative(W,{index:1638,receiver:c.object,argumentCount:0,evaluateArgument:()=>undefined});
  else ({[0x3df40]:C.scaleRanges,[0xb9f0]:C.forceClipChildSize,[0x41b30]:C.managerSetButtons,[0x41bd0]:C.managerSetScale,[0x3ed60]:C.computeThumbConfig,[0x3dda0]:C.scaleNumTicks,[0x3de40]:C.scaleThumbSpan,[0x3f170]:C.changeThumbPosition}[c.method])(W,c.object,...c.args.map(v=>v===0&&c.mode==='wiring'&&c.family==='manager'?null:v));
  const expected=Buffer.from(c.after,'hex');
  if(c.family==='scale'&&c.mode==='init'){
    assert.equal(strings.get(0x1dc),c.format);data.fill(0,0x1dc,0x1e8);expected.fill(0,0x1dc,0x1e8);
  }
  const differences=[];
  for(let off=0;off<data.length;off++)if(data[off]!==expected[off])differences.push(`+${off.toString(16)} got ${data[off].toString(16)} want ${expected[off].toString(16)}`);
  assert.equal(differences.length,0,`${c.family}/${c.mode}/${c.method.toString(16)}: ${differences.slice(0,12).join(', ')}`);
  assert.deepEqual(calls,c.calls);
}
console.log(`window-scroll-children: ${cases.length} original constructor/Init/thumb-geometry/wiring comparisons pass`);
