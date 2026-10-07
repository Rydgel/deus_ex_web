/** Differential check of window-host natives against their original exec bodies.
 *
 * One harness for the whole family: every listed native runs its registered
 * Extension.dll exec body (scripts/native-exec-diff-oracle.py) and the
 * JavaScript dispatchWindowHostNative case over the same receiver bytes and
 * argument stream. Cases come from the original UnrealScript signature: edge
 * values per parameter class, a skipped (EX_Nothing) case per optional
 * parameter, and several receiver byte patterns so masked writes and reads are
 * visible. The receiver image, the result slot and the recorded
 * AskParentForReconfigure events must match exactly. A native whose original
 * run is not a self-contained leaf for a case is reported, not compared.
 * See docs/native-exec-diff.md. */
import assert from 'node:assert/strict';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';
import {dispatchWindowHostNative} from '../src/runtime/script-window-host-natives.mjs';
import {loadExtensionNatives,patternBytes,encodeParam,runOracle} from './native-exec-diff-lib.mjs';

const RECEIVER_SIZE=0x800;
// Window-host natives whose recovered bodies are self-contained receiver
// reads/writes (optionally with AskParentForReconfigure).
const NATIVES=[1424,1474,1487,1495,1500,1510,1511,1512,1513,1514,1515,1516,1517,1518,1521,1522,1555,1559,1560,1561,1562,1563,
  1564,1572,1573,1595,1596,1597,1620,1621,1622,1623,1624,1625,1626,1627,1628,1629,1630,1631,1632,1633,1634,1635,1637,1639,1641,1644,1651,1652,
  1663,1664,1665,1666,1667,1668,1689,1701,1702,1703,1840,1841,1842,1843,1844,
  1945,1946,1947,1948,1950,1951,1955,1956];
// FString receiver fields a native reads, with the texts each case cycles
// through. Their 12 raw bytes hold oracle-local pointers and are not compared.
const STRINGS={
  1564:[{offset:0x168,texts:['','Open','|&Open','Save |&As','||&k','|x|&y','a|b|&c','|&','|&\u00ff','|&\u00fe','x|y']}],
};

const EDGES={
  ByteProperty:[0,1,0x7f,0x80,0xff],
  IntProperty:[0,1,-1,0x7fffffff,-0x80000000],
  BoolProperty:[false,true],
  FloatProperty:[0,-0,1.5,-3.25,3.4028234663852886e38,1e-45],
  ObjectProperty:[0,0x0bad0c0d],
  'struct:color':[[0,0,0,0],[0x12,0x34,0x56,0x78],[0xff,0x80,0x01,0xfe]],
  'struct:vector':[[0,0,0],[1.5,-3.25,1e-45],[3.4028234663852886e38,-0,0.1]],
  'struct:rotator':[[0,0,0],[1,-1,0x7fffffff],[-0x80000000,65536,-16384]],
};
const scriptValue=(shape,value)=>shape.kind==='struct:color'
  ?Object.fromEntries(['r','g','b','a'].map((key,i)=>[`core.object.color.${key}`,value[i]]))
  :value;

function casesFor(native){
  const cases=[],width=Math.max(1,...native.params.map(p=>EDGES[p.kind]?.length??0));
  const pick=(shape,i)=>EDGES[shape.kind][i%EDGES[shape.kind].length];
  for(let seed=0;seed<3;seed++)for(let i=0;i<width;i++)
    cases.push(native.params.map((shape,position)=>pick(shape,i+position+seed)));
  native.params.forEach((shape,position)=>{
    if(!shape.optional)return;
    // Skip this optional parameter and every later one (the compiler emits
    // EX_Nothing for each omitted trailing optional).
    for(let seed=0;seed<2;seed++)
      cases.push(native.params.map((other,j)=>j>=position?undefined:pick(other,seed+j)));
  });
  return cases;
}

function runScript(native,bytes,values,strings){
  const heap=createNativeHeap({capacity:1<<20}),win={name:'Receiver'};
  heap.allocate(win,RECEIVER_SIZE);
  bytes.forEach((byte,offset)=>heap.write(win,offset,'u8',byte));
  // Each string field starts as a constructed empty FString (the oracle builds
  // its own at that offset), then takes the case text through FString::operator=.
  for(const {offset,text} of strings){
    for(let i=0;i<12;i++)heap.write(win,offset+i,'u8',0);
    heap.write(win,offset,'string',text);
  }
  const events=[],f=Math.fround,record=op=>object=>events.push({op,object:object===win?'this':'other'});
  const W={heap,
    u8:(o,off)=>heap.read(o,off,'u8'),u32:(o,off)=>heap.read(o,off,'u32'),i32:(o,off)=>heap.read(o,off,'i32'),
    f32:(o,off)=>heap.read(o,off,'f32'),ptr:(o,off)=>heap.read(o,off,'u32'),
    setU8:(o,off,v)=>heap.write(o,off,'u8',v&0xff),setU32:(o,off,v)=>heap.write(o,off,'u32',v>>>0),
    setI32:(o,off,v)=>heap.write(o,off,'i32',v|0),setF32:(o,off,v)=>heap.write(o,off,'f32',f(v)),
    setPtr:(o,off,v)=>heap.write(o,off,'u32',heap.addressOf(v)),
    native:{askParentForReconfigure:record('AskParentForReconfigure'),makeAcceleratorTableDirty:record('MakeAcceleratorTableDirty')},
  };
  const call={index:native.index,receiver:win,argumentCount:values.length,
    evaluateArgument:i=>values[i]===undefined?undefined:scriptValue(native.params[i],values[i])};
  const out=dispatchWindowHostNative(W,call);
  assert.equal(out.handled,true,`${native.function} is not routed by dispatchWindowHostNative`);
  const after=new Uint8Array(RECEIVER_SIZE);
  for(let offset=0;offset<RECEIVER_SIZE;offset++)after[offset]=heap.read(win,offset,'u8');
  return {bytes:after,value:out.value,events};
}

function resultBytes(shape,value){
  if(!shape)return null;
  const bytes=new Uint8Array(shape.kind==='ByteProperty'?1:4),view=new DataView(bytes.buffer);
  if(shape.kind==='FloatProperty')view.setFloat32(0,value,true);
  else if(shape.kind==='BoolProperty')view.setUint32(0,value?1:0,true);
  else if(shape.kind==='ByteProperty')bytes[0]=value;
  else view.setUint32(0,Number(value)>>>0,true);
  return Buffer.from(bytes).toString('hex');
}

const natives=await loadExtensionNatives(),plan=[];
for(const index of NATIVES){
  const native=natives.get(index);
  assert.ok(native,`native ${index} has no registered Extension exec body`);
  const fields=STRINGS[index]??[];
  const rounds=Math.max(1,...fields.map(field=>field.texts.length));
  for(let round=0;round<rounds;round++)casesFor(native).forEach((values,n)=>{
    const bytes=patternBytes(RECEIVER_SIZE,index*97+n+round*7919);
    const strings=fields.map(({offset,texts})=>({offset,text:texts[(round+n)%texts.length]}));
    plan.push({native,values,bytes,strings,oracle:{id:`${index}:${round}:${n}`,exec:native.exec,strings,
      this:Buffer.from(bytes).toString('hex'),params:native.params.map((shape,i)=>encodeParam(shape,values[i]))}});
  });
}
// Focused ScrollArea x87 branches: equality preserves signed zero; an
// unordered comparison skips that axis, but another unequal axis writes both.
for(const [index,old,values] of [
  [1701,[-0],[0]],[1701,[NaN],[3]],[1701,[3],[NaN]],
  [1701,[Infinity],[Infinity]],[1701,[Infinity],[-Infinity]],
  [1702,[NaN,2],[3,2]],[1702,[NaN,2],[3,4]],
  [1702,[1,2],[NaN,4]],[1702,[-0,0],[0,-0]],
]){
  const native=natives.get(index),bytes=patternBytes(RECEIVER_SIZE,index),view=new DataView(bytes.buffer);
  old.forEach((v,i)=>view.setFloat32((index===1701?0x178:0x170)+i*4,v,true));
  plan.push({native,values,bytes,strings:[],oracle:{id:`${index}:comparison:${plan.length}`,exec:native.exec,
    this:Buffer.from(bytes).toString('hex'),params:native.params.map((shape,i)=>encodeParam(shape,values[i]))}});
}
// Focused Scale/ScaleManager x87 branches (docs/script-window-scale-settings.md):
// [native, {receiver offset: float32}, {offset: u32}, arguments].
for(const [index,floats,words,values] of [
  [1667,{0x16c:NaN},{},[3]],[1667,{0x16c:3},{},[NaN]],[1667,{0x16c:-0},{},[0]],[1667,{0x16c:Infinity},{},[Infinity]],
  [1666,{0x164:NaN,0x168:2},{},[3,2]],[1666,{0x164:NaN,0x168:2},{},[3,4]],[1666,{0x164:1,0x168:2},{},[1,NaN]],[1666,{0x164:-0,0x168:0},{},[0,-0]],
  [1627,{0x16c:NaN},{},[2,[1,2,3,4]]],[1627,{0x16c:2},{},[NaN,[1,2,3,4]]],[1628,{0x170:-0},{},[0,[5,6,7,8]]],[1628,{0x170:1},{},[-Infinity]],
  [1623,{},{},[0x0bad0c0d,true,NaN,NaN]],[1623,{},{},[0,false,-0,-Infinity]],[1623,{},{},[0x0bad0c0d,true,Infinity,1e-45]],
  // GetValue: value and range modes, an empty or one-tick count (midpoint), NaN and infinite ranges.
  ...[[0,10,3,-2.5,8.25],[16,10,3,-2.5,8.25],[0,1,0,1,3],[16,0,0,1,3],[0,0x80000000,5,0,1],[0,7,2,NaN,1],[16,7,2,-Infinity,Infinity],[0,7,9,1,1]]
    .map(([flags,count,position,from,to])=>[1644,{0x1d4:from,0x1d8:to},{0x164:flags,0x1c4:count,0x1c8:position},[]]),
]){
  const native=natives.get(index),bytes=patternBytes(RECEIVER_SIZE,index*31+plan.length),view=new DataView(bytes.buffer);
  for(const [offset,v] of Object.entries(floats))view.setFloat32(Number(offset),v,true);
  for(const [offset,v] of Object.entries(words))view.setUint32(Number(offset),v>>>0,true);
  plan.push({native,values,bytes,strings:[],oracle:{id:`${index}:focused:${plan.length}`,exec:native.exec,
    this:Buffer.from(bytes).toString('hex'),params:native.params.map((shape,i)=>encodeParam(shape,values[i]))}});
}
const results=runOracle(plan.map(entry=>entry.oracle));
const summary=new Map(),failures=[],notLeaf=[];
for(const [position,entry] of plan.entries()){
  const original=results[position],{native}=entry;
  const row=summary.get(native.index)??{name:native.function,cases:0,compared:0};summary.set(native.index,row);row.cases++;
  if(original.status!=='leaf'){notLeaf.push(`${native.function} case ${original.id}: ${original.status} ${original.reason??''}`);continue;}
  let script;
  try{script=runScript(native,entry.bytes,entry.values,entry.strings);}
  catch(error){failures.push(`${native.function} values ${JSON.stringify(entry.values)} strings ${JSON.stringify(entry.strings)}: script threw ${error.message}`);continue;}
  const expected=Buffer.from(original.this,'hex'),diffs=[];
  const ignored=offset=>entry.strings.some(field=>offset>=field.offset&&offset<field.offset+12);
  for(let offset=0;offset<RECEIVER_SIZE;offset++)
    if(!ignored(offset)&&expected[offset]!==script.bytes[offset])diffs.push(`+0x${offset.toString(16)} original ${expected[offset].toString(16)} script ${script.bytes[offset].toString(16)}`);
  const want=native.result?original.result.slice(0,resultBytes(native.result,0).length):null;
  const got=resultBytes(native.result,script.value);
  if(want!==got)diffs.push(`result original ${want} script ${got}`);
  if(JSON.stringify(original.events)!==JSON.stringify(script.events))
    diffs.push(`events original ${JSON.stringify(original.events)} script ${JSON.stringify(script.events)}`);
  if(original.codeAdvance!==native.params.length+1)diffs.push(`original consumed ${original.codeAdvance} code bytes`);
  if(diffs.length)failures.push(`${native.function} values ${JSON.stringify(entry.values)}${entry.strings.length?` strings ${JSON.stringify(entry.strings.map(field=>field.text))}`:''}: ${diffs.slice(0,4).join('; ')}`);
  else row.compared++;
}
for(const [index,row] of summary)console.log(`${String(index).padEnd(5)} ${row.name.padEnd(40)} ${row.compared}/${row.cases} identical`);
if(notLeaf.length)console.log(`not comparable (original run is not a leaf):\n  ${notLeaf.join('\n  ')}`);
if(failures.length){console.error(`MISMATCH:\n  ${failures.join('\n  ')}`);process.exitCode=1;}
else console.log(`window-native-diff: ${[...summary.values()].reduce((sum,row)=>sum+row.compared,0)} cases identical across ${summary.size} natives`);
