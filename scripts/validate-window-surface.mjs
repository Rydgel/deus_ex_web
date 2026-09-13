/** Validate the exact Window surface setters reached by InfoLink winLine. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {gameDirectory} from './game-directory.mjs';
import {GC_SURFACE_OFFSETS,WINDOW_SURFACE_NATIVE,WINDOW_SURFACE_OFFSETS,
  setWindowBackgroundNative,setWindowTileColorNative} from '../src/runtime/script-window-surface.mjs';

const root=gameDirectory(),system=path.join(root,'System');
const assets=new AssetStore((await readdir(system)).map(name=>({path:`System/${name}`,
  read:()=>readFile(path.join(system,name))})));
const extension=await assets.get('Extension');
for(const [pathName,evidence] of [['window.setbackground',WINDOW_SURFACE_NATIVE.setBackground],
  ['window.settilecolor',WINDOW_SURFACE_NATIVE.setTileColor]]){
  const index=extension.exportsByPath.get(pathName),metadata=readFunctionMetadata(extension,index);
  assert.equal(index,evidence.packageExport);assert.equal(metadata.nativeIndex,evidence.nativeIndex);
  assert.equal(metadata.functionFlags,evidence.functionFlags);assert.equal(metadata.entry.serialSize,evidence.serialSize);
  assert.equal(metadata.scriptSize,evidence.scriptSize);
}
const bytes=new Uint8Array(await readFile(path.join(system,'Extension.dll'))),sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(bytes),WINDOW_SURFACE_NATIVE.dllSha256);
const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),pe=view.getUint32(0x3c,true);
const sectionCount=view.getUint16(pe+6,true),optionalSize=view.getUint16(pe+20,true),table=pe+24+optionalSize;
function fileOffset(address){const rva=address-0x10000000;for(let i=0;i<sectionCount;i++){
  const s=table+i*40,virtualSize=view.getUint32(s+8,true),virtualAddress=view.getUint32(s+12,true);
  const rawSize=view.getUint32(s+16,true),rawAddress=view.getUint32(s+20,true);
  if(rva>=virtualAddress&&rva<virtualAddress+Math.max(virtualSize,rawSize))return rawAddress+rva-virtualAddress;
}throw new Error(`DLL address outside sections: 0x${address.toString(16)}`);}
for(const evidence of [WINDOW_SURFACE_NATIVE.setBackground,WINDOW_SURFACE_NATIVE.setTileColor]){
  assert.equal(sha(bytes.slice(fileOffset(evidence.execBody),fileOffset(evidence.execEnd))),evidence.execSha256);
  assert.equal(sha(bytes.slice(fileOffset(evidence.body),fileOffset(evidence.end))),evidence.bodySha256);
}
const gcEvidence=WINDOW_SURFACE_NATIVE.gcSetTileColor;
assert.equal(sha(bytes.slice(fileOffset(gcEvidence.body),fileOffset(gcEvidence.end))),gcEvidence.bodySha256);

const fields=new WeakMap();const object=name=>{const value={name};fields.set(value,new Map());return value;};
const window=object('window'),gc=object('gc'),solid=object('Texture Solid'),other=object('other');
fields.get(window).set(WINDOW_SURFACE_OFFSETS.background,other);
fields.get(window).set(WINDOW_SURFACE_OFFSETS.graphicsContext,gc);
const trace=[],services={
  read:(target,offset,kind)=>{const value=fields.get(target).get(offset)??(kind==='ptr'?null:0);trace.push(['read',target.name,offset,kind]);return value;},
  write:(target,offset,kind,value)=>{fields.get(target).set(offset,value);trace.push(['write',target.name,offset,kind,value]);},
  askParentForReconfigure:({object:target,caller})=>trace.push(['reconfigure',target.name,caller]),
};
assert.equal(setWindowBackgroundNative(window,solid,services),true);
assert.equal(fields.get(window).get(WINDOW_SURFACE_OFFSETS.background),solid);
assert.equal(setWindowBackgroundNative(window,solid,services),false);
assert.equal(trace.filter(entry=>entry[0]==='reconfigure').length,1);
const color={r:200,g:201,b:202,a:7};
const result=setWindowTileColorNative(window,color,services);
assert.equal(result.packed,0x07cac9c8);assert.equal(result.graphicsContext,gc);
assert.equal(fields.get(window).get(WINDOW_SURFACE_OFFSETS.packedTileColor),0x07cac9c8);
assert.equal(fields.get(gc).get(GC_SURFACE_OFFSETS.packedTileColor),0x07cac9c8);
for(const [target,offset] of [[window,WINDOW_SURFACE_OFFSETS.tilePlane],[gc,GC_SURFACE_OFFSETS.tilePlane]]){
  assert.equal(fields.get(target).get(offset),Math.fround(200/255));
  assert.equal(fields.get(target).get(offset+4),Math.fround(201/255));
  assert.equal(fields.get(target).get(offset+8),Math.fround(202/255));
  assert.equal(fields.get(target).get(offset+12),0);
}
console.log('Window surface setters match the installed Extension metadata and unchanged DLL bodies: '+
  'background identity/reconfigure order plus packed and normalized Window/XGC tile colours.');
