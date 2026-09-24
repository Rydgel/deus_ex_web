/** Window.SetBaselineData1484: full exec + GC callee comparison, including null GC. */
import assert from 'node:assert/strict';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';
import {dispatchWindowHostNative} from '../src/runtime/script-window-host-natives.mjs';
import {loadExtensionNatives,patternBytes,encodeParam,runOracle} from './native-exec-diff-lib.mjs';

const native=(await loadExtensionNatives()).get(1484);
assert.equal(native.function,'Window.SetBaselineData');
assert.equal(native.exec,0x10053de0);
assert.deepEqual(native.params.map(p=>[p.kind,p.optional]),[['FloatProperty',true],['FloatProperty',true]]);
assert.equal(native.result,null);
const values=[[],[undefined,undefined],[7.5], [undefined,-4],[-3.25,9.5],[-0,0],
  [1e-45,-1e-45],[3.4028234663852886e38,-3.4028234663852886e38],
  [Infinity,-Infinity],[NaN,NaN],[2,1]];
const plan=[];
for(const hasGc of [false,true])for(const [i,args] of values.entries()){
  const window=patternBytes(0x180,1484+i),gc=patternBytes(0xc8,1262+i);
  new DataView(window.buffer).setUint32(0x130,0,true);
  plan.push({args,window,gc,hasGc,oracle:{id:`${hasGc?'gc':'null'}:${i}`,exec:native.exec,
    this:Buffer.from(window).toString('hex'),
    params:native.params.map((shape,j)=>encodeParam(shape,args[j])),
    pointees:hasGc?[{offset:0x130,bytes:Buffer.from(gc).toString('hex')}]:[]}});
}
const results=runOracle(plan.map(p=>p.oracle));
assert.equal(results.length,plan.length);
for(const [i,entry] of plan.entries()){
  const original=results[i];
  assert.equal(original.status,'leaf',JSON.stringify(original));
  assert.equal(original.codeAdvance,3);
  assert.equal(original.paramsLeft,0);
  assert.equal(original.result,'cd'.repeat(0x20));
  assert.deepEqual(original.events,[]);
  const after=Buffer.from(original.this,'hex');
  // Only the harness pointer differs; the method must not write the window.
  after.fill(0,0x130,0x134);
  assert.deepEqual(after,Buffer.from(entry.window));
  if(entry.hasGc){
    const expected=Buffer.from(entry.gc);
    expected.writeFloatLE(entry.args[0]??2,0x8c);
    expected.writeFloatLE(entry.args[1]??1,0x88);
    assert.deepEqual(Buffer.from(original.pointees[0].bytes,'hex'),expected);
  }
}
// Run the real dispatcher over the identical two memory images. Record the
// evaluation/pointer-read order as well as comparing all stored bytes.
for(const [i,entry] of plan.entries()){
  const heap=createNativeHeap({capacity:1<<16}),win={},gc={},order=[];
  heap.allocate(win,entry.window.length);heap.allocate(gc,entry.gc.length);
  entry.window.forEach((byte,offset)=>heap.write(win,offset,'u8',byte));
  entry.gc.forEach((byte,offset)=>heap.write(gc,offset,'u8',byte));
  heap.write(win,0x130,'ptr',entry.hasGc?gc:null);
  const W={ptr:(object,offset)=>{order.push('gc');return heap.read(object,offset,'ptr');},
    gc:{services:{mem:heap.mem,objectAddress:object=>heap.objectAddress(object)}}};
  const actual=dispatchWindowHostNative(W,{index:1484,receiver:win,argumentCount:entry.args.length,
    evaluateArgument:j=>{order.push(j);return entry.args[j];}});
  assert.deepEqual(actual,{handled:true,value:undefined});
  assert.deepEqual(order,[...entry.args.keys(),'gc']);
  const bytes=(object,size)=>Buffer.from(Array.from({length:size},(_,offset)=>heap.read(object,offset,'u8')));
  const original=Buffer.from(results[i].this,'hex'),translated=bytes(win,entry.window.length);
  original.fill(0,0x130,0x134);translated.fill(0,0x130,0x134);
  assert.deepEqual(translated,original);
  assert.deepEqual(bytes(gc,entry.gc.length),entry.hasGc?Buffer.from(results[i].pointees[0].bytes,'hex'):Buffer.from(entry.gc));
}
console.log(`window-baseline: ${results.length} original exec/GC cases match the runtime dispatcher`);
