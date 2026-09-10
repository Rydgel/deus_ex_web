import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata,readStateMetadata} from '../src/unreal/script-metadata.mjs';
import {decodeScript} from '../src/unreal/bytecode.mjs';
import {primitiveNativeIndices} from '../src/runtime/script-vm.mjs';
import {gameDirectory} from './game-directory.mjs';

// Inspect the engine/game/UI script packages, without loading unrelated audio
// payloads or treating the existence of a declaration as native compatibility.
const packageNames=['Core','Engine','Extension','ConSys','DeusEx','UWindow','DeusExUI','Fire'];
const root=gameDirectory(),files=[];
for(const name of await readdir(path.join(root,'System')))files.push({path:name,
  read:()=>readFile(path.join(root,'System',name))});
const assets=new AssetStore(files),packages=[],declarations=new Map(),finalCalls=new Map();
const add=(counts,key)=>counts.set(key,(counts.get(key)??0)+1);
for(const name of packageNames){
  const asset=await assets.get(name),directCalls=new Map(),virtualCalls=new Map(),tokens=new Map();
  const result={name,version:asset.pkg.version,sha256:createHash('sha256').update(asset.bytes).digest('hex'),
    classes:0,functions:0,states:0,decodedScripts:0,nativeDeclarations:[],decodeErrors:[]};
  for(const [i,entry] of asset.pkg.exports.entries()){
    if(entry.className==='Class')result.classes++;
    if(!['Function','State'].includes(entry.className))continue;
    result[entry.className==='Function'?'functions':'states']++;
    const key=`${name}.${entry.path}`;
    try{
      const script=(entry.className==='Function'?readFunctionMetadata:readStateMetadata)(asset,i+1,{includeChildren:false});
      if(script.functionFlags&0x400){
        const native={function:key,index:script.nativeIndex,flags:script.functionFlags};
        result.nativeDeclarations.push(native);declarations.set(key.toLowerCase(),native);
      }
      const decoded=decodeScript(script);result.decodedScripts++;
      for(const node of decoded.expressions.values()){
        add(tokens,`0x${node.token.toString(16).padStart(2,'0')}`);
        if(node.op==='native')add(directCalls,node.index);
        if(node.op===0x1b||node.op===0x38)add(virtualCalls,node.name);
        if(node.op===0x1c){
          const target=await assets.resolve(asset,node.functionIndex);
          add(finalCalls,target.key.toLowerCase());
        }
      }
    }catch(error){result.decodeErrors.push({function:key,error:error.message});}
  }
  result.directNativeCalls=Object.fromEntries([...directCalls].sort((a,b)=>a[0]-b[0]));
  result.virtualCalls=Object.fromEntries([...virtualCalls].sort((a,b)=>b[1]-a[1]));
  result.opcodes=Object.fromEntries([...tokens].sort((a,b)=>a[0].localeCompare(b[0])));
  packages.push(result);
}
const bindings={
  primitives:primitiveNativeIndices,
  common:[{index:113,scope:'GotoState with linked class/state lookup and serialized-order Auto selection'},
    {index:117,scope:'Enable a declared probe on the current state frame'},
    {index:118,scope:'Disable a probe on the current state frame'},
    {index:195,scope:'FRand with the shared original MSVCRT random stream and float32 result'},
    {index:256,scope:'Sleep, finite actor state path'},
    {index:272,scope:'SetOwner with linked actor fields and original LostChild/GainedChild events'},
    {index:278,scope:'CameraPoint native construction/startup in an explicitly supplied standalone world'},
    {index:279,scope:'Destroy with explicit world validation, collision/relationship services and native object registration'},
    {index:280,scope:'SetTimer, typed actor timer fields'},
    {index:299,scope:'SetRotation zero-delta short path; full rider/brush movement remains unsupported'},
    {index:303,scope:'IsA by original short class names for attached script instances'},
    {index:304,scope:'AllActors with an explicitly linked complete actor array'}],
  doors:[{index:264,scope:'Deferred sound boundary; audio playback is unimplemented'},
    {index:301,scope:'FinishInterpolation and latent poll302'},
    {index:724,scope:'Selected nonexact mover bounds'},
    {index:3970,scope:'Already active PHYS_MovingBrush only'}],
};
const report={packages,bindings,finalNativeCalls:[...finalCalls].flatMap(([key,count])=>
  declarations.has(key)?[{...declarations.get(key),count}]:[]),
  note:'Declarations and decoded opcodes do not establish execution support. Bindings describe scoped branches only; virtual dispatch and unindexed native hooks require separate coverage.'};
const output=path.resolve(process.argv[2]??'.cache/script-runtime-inventory.json');
await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({report:output,packages:packages.map(p=>({name:p.name,classes:p.classes,
  functions:p.functions,states:p.states,nativeDeclarations:p.nativeDeclarations.length,
  directNativeIndices:Object.keys(p.directNativeCalls).length,decodeErrors:p.decodeErrors.length}))},null,2));
if(packages.some(p=>p.decodeErrors.length))process.exitCode=1;
