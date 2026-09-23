/** Root.Tick/MoveTabGroup branch and leaf-order comparisons with original DLL. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {rootTickNative,moveTabGroupNative} from '../src/runtime/script-window-root-tick.mjs';
import {gameDirectory} from './game-directory.mjs';
const cases=[{}, {groups:true}, {groups:true,selectable:true},
  {groups:true,selectable:true,preferred:true}, {groups:true,preferred:true},
  {groups:true,selectable:true,modal:true}, {groups:true,selectable:true,modalMode:3},
  {groups:true,selectable:true,focus:'y'}, {groups:true,changed:true},
  ...[0,1,2,3].map(direction=>({groups:true,selectable:true,focus:'x',direction})),
  {timerBits:0x3dcccccd,dtBits:0x3e800000}, {timerBits:0x80000000,dtBits:0},
  {timerBits:0x7fc00000}, {timerBits:1,dtBits:0x80000001}];
const native=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON||path.resolve('.cache/native-probe-env/bin/python'),
  [path.resolve('scripts/native-window-root-tick-oracle.py'),gameDirectory()],
  {input:JSON.stringify(cases),encoding:'utf8',maxBuffer:2**20}));
assert.equal(native.hash,'93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c');
const bits=new DataView(new ArrayBuffer(4));
const fromBits=n=>{bits.setUint32(0,n,true);return bits.getFloat32(0,true);};
const toBits=n=>{bits.setFloat32(0,n,true);return bits.getUint32(0,true);};
for(const [index,c] of cases.entries()){
  const events=[],objects=Object.fromEntries(['root','modal','a','b','x','y'].map(name=>[name,{name,0x30:3}]));
  const {root,modal,a,b,x,y}=objects,active=c.modal?modal:root;
  root[0x28]=3;
  if(c.modal){modal[0x28]=2;modal[0x138]=root;root[0x140]=modal;}
  active[0x174]=c.modalMode??0;
  for(const [i,[group,row]] of [[a,x],[b,y]].entries()){
    Object.assign(group,{0x28:1,0x138:active,0x168:i,0x14c:[row]});
    Object.assign(row,{0x138:group,0x30:c.selectable?7:3});
  }
  active[0x17c]=c.groups?[a,b]:[];
  if(c.preferred)active[0x178]=x;
  root[0x5c8]=objects[c.focus]??null;root[0x620]=fromBits(c.timerBits??0x3f800000);
  const W={u8:(o,k)=>(o[k]??0)&255,ptr:(o,k)=>o[k]??null,i32:(o,k)=>o[k]??0,
    f32:(o,k)=>o[k]??0,setF32:(o,k,v)=>{o[k]=Math.fround(v);},
    farray:{num:(o,k)=>(o[k]??[]).length,ptr:(o,k,i)=>o[k]?.[i]??null}};
  // Boundary fixtures use the original tree helpers' raw ancestry/flags contract.
  const ancestor=(o,type)=>{for(;o;o=o[0x138])if(o[0x28]>=type)return o;return null;};
  const S={topChild:(_,o)=>o[0x140]??null,lowerSibling:()=>null,
    getRootWindow:()=>root,getModalWindow:(_,o)=>ancestor(o,2),getTabGroupWindow:(_,o)=>ancestor(o,1),
    isTraversable:(_,o)=>{if(!(o[0x30]&4))return false;for(;o;o=o[0x138])if((o[0x30]&3)!==3)return false;return true;},
    computeTabGroupLocation:(_,o)=>{events.push(['compute',o.name]);return !!c.changed;},
    resortTabGroupTable:(_,o)=>events.push(['resort',o.name]),
    setFocusWindow:(o,target)=>{events.push(['focus',o.name,target.name]);o[0x5c8]=target;},
    buildAcceleratorTable:(_,o)=>events.push(['accelerators',o.name])};
  if(c.direction!==undefined)moveTabGroupNative(W,root,c.direction,S);
  else rootTickNative(W,root,fromBits(c.dtBits??0x3e800000),S);
  assert.deepEqual({focus:root[0x5c8]?.name??null,timerBits:toBits(root[0x620]),events},native.cases[index],JSON.stringify(c));
}
console.log(`Window root Tick/MoveTabGroup: ${cases.length} original DLL comparisons passed`);
