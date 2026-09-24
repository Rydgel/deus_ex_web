/** Original native1439 exec + scanner + modal dirty walk, versus the live dispatcher. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {loadExtensionNatives} from './native-exec-diff-lib.mjs';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';
import {dispatchWindowHostNative} from '../src/runtime/script-window-host-natives.mjs';
import {makeAcceleratorTableDirty} from '../src/runtime/script-window-tree-natives.mjs';

const native=(await loadExtensionNatives()).get(1439);
assert.equal(native.exec,0x100524a0);
assert.deepEqual(native.params.map(p=>[p.kind,p.optional]),[['StrProperty',false]]);
assert.equal(native.result,null);
const cases=[
  ['',99,0],['Ordinary',99,0],['|&Heal',99,72],['||&k',99,0],
  ['|x|&y',99,121],['|&a |&b',99,97],['|&',99,0],
  ['|&\u00fe',99,254],['|&\u00ff',99,0],['|&\u0100',99,0],
  ['a\0|&z',99,0],['|&h',104,104],['',0,0],
].map(([text,old,key])=>({key,spec:{accelKey:old,parent:{windowType:2,accelFlags:0xa4}},
  args:[{string:text}],captureImages:true}));
// Nearest modal wins even with a root above it; no modal means no dirty write.
cases.push({key:65,spec:{windowType:2,accelKey:0,parent:{windowType:3}},args:[{string:'|&A'}],captureImages:true});
cases.push({key:65,spec:{parent:{parent:{windowType:2,parent:{windowType:3}}}},args:[{string:'|&A'}],captureImages:true});
cases.push({key:65,spec:{parent:{}},args:[{string:'|&A'}],captureImages:true});
const python=process.env.NATIVE_PROBE_PYTHON;
assert.ok(python,'Set NATIVE_PROBE_PYTHON to the Unicorn environment');
const original=JSON.parse(execFileSync(python,['scripts/native-textwindow-probe.py',gameDirectory()],{
  input:JSON.stringify({method:'SetAcceleratorText',cases}),encoding:'utf8',maxBuffer:1<<24}));
assert.equal(original.length,cases.length);
for(const [i,result] of original.entries()){
  assert.equal(result.code,2);
  assert.equal(result.state.accelKey,cases[i].key);
  assert.equal(result.state.convertFlag,0,'exec does not convert pipes');
  assert.ok(!result.events.some(e=>e.op==='AskParentForReconfigure'));
  const heap=createNativeHeap({capacity:1<<20}),objects=result.images.map(()=>({}));
  result.images.forEach((image,j)=>{
    const before=Buffer.from(image.before,'hex');heap.allocate(objects[j],before.length);
    before.forEach((byte,offset)=>heap.write(objects[j],offset,'u8',byte));
  });
  objects.forEach((object,j)=>heap.write(object,0x138,'ptr',objects[j+1]??null));
  const W={heap,ptr:(o,off)=>heap.read(o,off,'ptr'),u8:(o,off)=>heap.read(o,off,'u8'),
    u32:(o,off)=>heap.read(o,off,'u32'),setU32:(o,off,v)=>heap.write(o,off,'u32',v),
    native:{makeAcceleratorTableDirty:object=>makeAcceleratorTableDirty(W,object)}};
  let evaluated=0;
  const out=dispatchWindowHostNative(W,{index:1439,receiver:objects[0],argumentCount:1,
    evaluateArgument:j=>{assert.equal(j,0);evaluated++;return cases[i].args[0].string;}});
  assert.equal(evaluated,1);assert.deepEqual(out,{handled:true,value:undefined});
  result.images.forEach((image,j)=>{
    const expected=Buffer.from(image.after,'hex');
    const actual=Buffer.from(Array.from({length:expected.length},(_,off)=>heap.read(objects[j],off,'u8')));
    // Parent identities relocate between the two heaps; every other byte,
    // including untouched vtable and string headers, must remain identical.
    assert.equal(heap.read(objects[j],0x138,'ptr'),objects[j+1]??null);
    expected.fill(0,0x138,0x13c);actual.fill(0,0x138,0x13c);
    assert.deepEqual(actual,expected,`case ${i}, image ${j}`);
  });
}
console.log(`window-accelerator-text: ${cases.length} original exec/scanner/parent-walk comparisons pass`);
