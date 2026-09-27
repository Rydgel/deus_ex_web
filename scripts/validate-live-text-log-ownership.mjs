/** Regression for the live Extension-window AddLog/Tick byte-image path.
 *
 * Native reference: Extension-annotated.asm 0x10047721..2f zeroes a new
 * 0x14-byte AddLog row; 0x10047d14..5b destroys expired-prefix FStrings; the
 * final Core FArray::Remove(0,n,0x14) uses the 0x101454f0 shrink policy.
 * This sequence expires a prefix, keeps one FString survivor, reuses the
 * retained row capacity, then expires all rows and releases the array.
 */
import assert from 'node:assert/strict';
import {createNativeHeap} from '../src/runtime/script-native-heap.mjs';
import {dispatchWindowHostNative} from '../src/runtime/script-window-host-natives.mjs';
import {textLogTick} from '../src/runtime/script-window-text-log.mjs';

const heap=createNativeHeap({capacity:1<<20}),win={};heap.allocate(win,0x200);
let now=0;
const W={heap,
 u8:(o,off)=>heap.read(o,off,'u8'),u32:(o,off)=>heap.read(o,off,'u32'),i32:(o,off)=>heap.read(o,off,'i32'),
 f32:(o,off)=>heap.read(o,off,'f32'),
 setU32:(o,off,v)=>heap.write(o,off,'u32',v>>>0),setI32:(o,off,v)=>heap.write(o,off,'i32',v|0),
 setF32:(o,off,v)=>heap.write(o,off,'f32',Math.fround(v)),tickOffset:()=>now,
 native:{askParentForReconfigure:()=>{}},
 farray:{
  realloc(o,off,size){
   const max=W.i32(o,off+8),num=W.i32(o,off+4),old=W.u32(o,off);
   if(max<=0){W.setU32(o,off,0);if(old)heap.freeRaw(old);return;}
   const next=heap.allocRaw(max*size);
   if(old){heap.copyBytes(next,old,Math.min(num,max)*size);heap.freeRaw(old);}
   W.setU32(o,off,next);
  },
  add(o,off,count,size){
   const index=W.i32(o,off+4),num=index+count;W.setI32(o,off+4,num);
   if(num>W.i32(o,off+8)){W.setI32(o,off+8,num+Math.trunc(3*num/8)+32);this.realloc(o,off,size);}
   return index;
  },
 },
};
heap.write(win,0x168,'string','');
const add=(text,color)=>dispatchWindowHostNative(W,{index:1570,receiver:win,argumentCount:2,
 evaluateArgument:i=>i===0?text:{'core.object.color.r':color[0],'core.object.color.g':color[1],
  'core.object.color.b':color[2],'core.object.color.a':color[3]}});
const count=()=>W.i32(win,0x17c),data=()=>W.u32(win,0x178),line=i=>heap.read(data()+i*20+4,0,'string');

W.setF32(win,0x174,1);
assert.deepEqual(add('expired',[1,2,3,4]),{handled:true,value:undefined});
now=2;W.setF32(win,0x174,100);
add('survivor',[5,6,7,8]);
const capacity=W.i32(win,0x178+8);
assert.ok(capacity>0,'AddLog must allocate row capacity before the expiry sequence');
textLogTick(W,win,2);
assert.equal(count(),1);
assert.equal(line(0),'survivor');
assert.equal(heap.read(win,0x168,'string'),'survivor');
assert.equal(W.i32(win,0x178+8),capacity,'prefix removal should retain the native array capacity');

add('reused row',[9,10,11,12]);
assert.equal(count(),2);
assert.equal(line(0),'survivor');
assert.equal(line(1),'reused row');
assert.equal(heap.read(win,0x168,'string'),'survivor\nreused row');

textLogTick(W,win,200);
assert.equal(count(),0);
assert.equal(W.u32(win,0x178),0,'Core FArray::Remove releases the empty row array');
assert.equal(W.i32(win,0x178+8),0);
assert.equal(heap.read(win,0x168,'string'),'');
console.log('live TextLog AddLog/Tick ownership: expired prefix, survivor reuse, and empty shrink match original contract');
