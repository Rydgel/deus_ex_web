/** Shared driver for scripts/native-exec-diff-oracle.py.
 *
 * Builds exec-level cases for registered Extension natives from their original
 * UnrealScript signatures (package metadata) and exec addresses (the
 * GRegisterNative table recovered by tools/native-registry.py), runs them in
 * one oracle process, and compares a JavaScript implementation against the
 * same receiver bytes and argument stream. Local research tool: requires the
 * hash-pinned installation and NATIVE_PROBE_PYTHON. */
import {execFileSync} from 'node:child_process';
import {readFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata,readPropertyMetadata} from '../src/unreal/script-metadata.mjs';
import {gameDirectory} from './game-directory.mjs';

const here=path.dirname(new URL(import.meta.url).pathname);
const python=()=>{
  const executable=process.env.NATIVE_PROBE_PYTHON;
  if(!executable)throw new Error('Set NATIVE_PROBE_PYTHON to the Unicorn probe environment (see docs/native-exec-diff.md)');
  return executable;
};

// Bytes a GNatives expression evaluation writes for each parameter class.
// Byte locals are one byte: a wider write would clobber the exec frame.
const PARAM_SIZE={ByteProperty:1,IntProperty:4,BoolProperty:4,FloatProperty:4,ObjectProperty:4,
  ClassProperty:4,NameProperty:4,StrProperty:12};
const STRUCT_SIZE={color:4,vector:12,rotator:12};

export async function loadExtensionNatives(){
  const root=gameDirectory(),files=[];
  for(const name of await readdir(path.join(root,'System')))
    files.push({path:`System/${name}`,read:()=>readFile(path.join(root,'System',name))});
  const asset=await new AssetStore(files).get('Extension');
  const registryFile=path.join(os.tmpdir(),`extension-native-registry-${process.pid}.json`);
  execFileSync('python3',[path.join(here,'../tools/native-registry.py'),'Extension','--root',root,'--json',registryFile],{stdio:'ignore'});
  const registry=JSON.parse(await readFile(registryFile,'utf8'));
  await rm(registryFile,{force:true});
  const natives=new Map();
  for(const [position,entry] of asset.pkg.exports.entries()){
    if(entry.className!=='Function')continue;
    const script=readFunctionMetadata(asset,position+1);
    if(!script.nativeIndex||!registry[script.nativeIndex])continue;
    const params=[];let result=null;
    for(const child of script.children){
      if(!child.className?.endsWith('Property'))continue;
      const property=readPropertyMetadata(asset,child.index);
      if(!(property.flags&0x80))continue;
      const kind=child.className==='StructProperty'?`struct:${String(property.struct?.name??'').toLowerCase()}`:child.className;
      const size=child.className==='StructProperty'?STRUCT_SIZE[kind.slice(7)]:PARAM_SIZE[child.className];
      const shape={name:property.name,kind,size:size??null,optional:Boolean(property.flags&0x10),out:Boolean(property.flags&0x100)};
      if(property.flags&0x400)result=shape;else params.push(shape);
    }
    natives.set(script.nativeIndex,{index:script.nativeIndex,function:entry.path,exec:registry[script.nativeIndex].body,params,result});
  }
  return natives;
}

/** Deterministic receiver bytes: every byte distinct enough that a read,
 * masked write or width error changes the compared image. */
export function patternBytes(size,seed){
  const bytes=new Uint8Array(size);let state=(seed*2654435761)>>>0||1;
  for(let i=0;i<size;i++){state^=state<<13;state^=state>>>17;state^=state<<5;bytes[i]=state&0xff;}
  return bytes;
}
const hex=bytes=>Buffer.from(bytes).toString('hex');

/** Encode one parameter value at its exec width; undefined means EX_Nothing. */
export function encodeParam(shape,value){
  if(value===undefined)return {skip:true};
  const bytes=new Uint8Array(shape.size),view=new DataView(bytes.buffer);
  if(shape.kind==='FloatProperty')view.setFloat32(0,value,true);
  else if(shape.kind==='struct:color')value.forEach((component,i)=>{bytes[i]=component&0xff;});
  else if(shape.kind==='struct:vector'||shape.kind==='struct:rotator')
    value.forEach((component,i)=>shape.kind==='struct:vector'?view.setFloat32(4*i,component,true):view.setInt32(4*i,component,true));
  else if(shape.size===1)bytes[0]=value&0xff;
  else if(shape.kind==='BoolProperty')view.setUint32(0,value?1:0,true);
  else view.setUint32(0,value>>>0,true);
  return {bytes:hex(bytes)};
}

export function runOracle(cases){
  if(!cases.length)return [];
  const output=execFileSync(python(),[path.join(here,'native-exec-diff-oracle.py')],
    {input:JSON.stringify({cases}),encoding:'utf8',maxBuffer:1<<28});
  return output.trim().split('\n').map(line=>JSON.parse(line));
}
