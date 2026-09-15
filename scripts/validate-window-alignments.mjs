/** Focused original comparison for Window.SetWindowAlignments. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {WINDOW_POSITION_OFFSETS} from '../src/runtime/script-window-position.mjs';
import {
  WINDOW_ALIGNMENTS_NATIVE,
  WINDOW_ALIGNMENTS_OFFSETS,
  setWindowAlignmentsNative,
} from '../src/runtime/script-window-alignments.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),system=path.join(root,'System');
const assets=new AssetStore((await readdir(system)).map(name=>({path:`System/${name}`,read:()=>readFile(path.join(system,name))})));
const extension=await assets.get('Extension');
const index=extension.exportsByPath.get('window.setwindowalignments');
assert.equal(index,WINDOW_ALIGNMENTS_NATIVE.packageExport);
const metadata=readFunctionMetadata(extension,index);
assert.equal(metadata.nativeIndex,WINDOW_ALIGNMENTS_NATIVE.nativeIndex);
assert.equal(metadata.functionFlags,WINDOW_ALIGNMENTS_NATIVE.functionFlags);
assert.equal(metadata.entry.serialSize,WINDOW_ALIGNMENTS_NATIVE.serialSize);
assert.deepEqual(metadata.parameters.map(parameter=>parameter.name),
  ['HAlign','VAlign','hMargin0','vMargin0','hMargin1','vMargin1']);
assert.equal(WINDOW_ALIGNMENTS_OFFSETS.hAlign,WINDOW_POSITION_OFFSETS.alignmentX);
assert.equal(WINDOW_ALIGNMENTS_OFFSETS.vAlign,WINDOW_POSITION_OFFSETS.alignmentY);
assert.equal(WINDOW_ALIGNMENTS_OFFSETS.hMargin0,WINDOW_POSITION_OFFSETS.x);
assert.equal(WINDOW_ALIGNMENTS_OFFSETS.vMargin0,WINDOW_POSITION_OFFSETS.y);

const dll=new Uint8Array(await readFile(path.join(system,'Extension.dll')));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(dll),WINDOW_ALIGNMENTS_NATIVE.dllSha256);
for(const [start,end,hash] of [
  [WINDOW_ALIGNMENTS_NATIVE.execBody,WINDOW_ALIGNMENTS_NATIVE.execEnd,WINDOW_ALIGNMENTS_NATIVE.execSha256],
  [WINDOW_ALIGNMENTS_NATIVE.setAlignmentsBody,WINDOW_ALIGNMENTS_NATIVE.setAlignmentsEnd,WINDOW_ALIGNMENTS_NATIVE.setAlignmentsSha256],
])assert.equal(sha(dll.subarray(start-0x10000000,end-0x10000000)),hash);

const python=process.env.NATIVE_PROBE_PYTHON||path.resolve('.cache/native-probe-env/bin/python');
const original=JSON.parse(execFileSync(python,[path.resolve('scripts/native-window-alignments-oracle.py'),root],{encoding:'utf8'}));
assert.equal(original.hashes['Extension.dll'],WINDOW_ALIGNMENTS_NATIVE.dllSha256);
assert.equal(original.addresses.setWindowAlignments,0x1204d300);

const fromBits=bits=>{const b=new ArrayBuffer(4),v=new DataView(b);v.setUint32(0,bits>>>0,true);return v.getFloat32(0,true);};
const toBits=value=>{const b=new ArrayBuffer(4),v=new DataView(b);v.setFloat32(0,value,true);return v.getUint32(0,true);};
const O=WINDOW_ALIGNMENTS_OFFSETS;

function fixture(alignment, margin){
  const object={bytes:new Uint8Array(0x200)};
  object.bytes.fill(0xaa);
  const view=new DataView(object.bytes.buffer);
  view.setUint8(O.hAlign,alignment[0]);
  view.setUint8(O.vAlign,alignment[1]);
  view.setUint32(O.hMargin0,margin[0]>>>0,true);
  view.setUint32(O.hMargin1,margin[1]>>>0,true);
  view.setUint32(O.vMargin0,margin[2]>>>0,true);
  view.setUint32(O.vMargin1,margin[3]>>>0,true);
  const accesses=[],events=[];
  const services={
    read:(target,offset,kind)=>{
      const value=kind==='u8'?new DataView(target.bytes.buffer).getUint8(offset)
        :new DataView(target.bytes.buffer).getFloat32(offset,true);
      accesses.push({op:'read',offset,kind,bits:kind==='u8'?value:toBits(value)});
      return value;
    },
    write:(target,offset,kind,value)=>{
      const targetView=new DataView(target.bytes.buffer);
      if(kind==='u8')targetView.setUint8(offset,value);
      else targetView.setFloat32(offset,value,true);
      accesses.push({op:'write',offset,kind,bits:kind==='u8'?value:toBits(value)});
    },
    askParentForReconfigure:()=>events.push({op:'AskParentForReconfigure'}),
  };
  return {object,accesses,events,services,view:new DataView(object.bytes.buffer)};
}

const nan=0x7fc12345;
const zero=[0,0,0,0];
const cases={
  hAlign:{alignment:[0,0],margin:zero,request:[1,0,0,0,0,0]},
  vAlign:{alignment:[0,0],margin:zero,request:[0,2,0,0,0,0]},
  hMargin0:{alignment:[3,3],margin:zero,request:[3,3,fromBits(toBits(1)),0,0,0]},
  hMargin1:{alignment:[3,3],margin:zero,request:[3,3,0,0,fromBits(toBits(4)),0]},
  vMargin0:{alignment:[3,3],margin:zero,request:[3,3,0,fromBits(toBits(5)),0,0]},
  vMargin1:{alignment:[3,3],margin:zero,request:[3,3,0,0,0,fromBits(toBits(6))]},
  unchanged:{alignment:[3,3],margin:[toBits(1),toBits(4),toBits(5),toBits(6)],
    request:[3,3,fromBits(toBits(1)),fromBits(toBits(5)),fromBits(toBits(4)),fromBits(toBits(6))]},
  negativeZero:{alignment:[0,0],margin:zero,request:[0,0,-0,-0,-0,-0]},
  storedNaN:{alignment:[0,0],margin:[nan,0,0,0],request:[0,0,fromBits(toBits(1)),0,0,0]},
};

for(const [name,reference] of Object.entries(original.cases)){
  const expected=cases[name];
  const translated=fixture(expected.alignment,expected.margin);
  setWindowAlignmentsNative(translated.object,...expected.request,translated.services);
  const finalAlign=[translated.view.getUint8(O.hAlign),translated.view.getUint8(O.vAlign)];
  const finalMargin=[
    translated.view.getUint32(O.hMargin0,true),translated.view.getUint32(O.hMargin1,true),
    translated.view.getUint32(O.vMargin0,true),translated.view.getUint32(O.vMargin1,true),
  ];
  assert.deepEqual(translated.accesses,reference.accesses,name+' access order/bits');
  assert.deepEqual(translated.events,reference.events,name+' callback order');
  assert.deepEqual(finalAlign,reference.finalAlign,name+' final alignment');
  assert.deepEqual(finalMargin,reference.finalMargin,name+' final margin bits');
}
console.log('Window.SetWindowAlignments matches the unchanged Extension.dll body: byte then x87 C3 compares, original store order, signed zero/NaN, reconfigure.');
