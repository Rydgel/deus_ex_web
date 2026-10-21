import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata,readStateMetadata} from '../src/unreal/script-metadata.mjs';
import {decodeScript} from '../src/unreal/bytecode.mjs';
import {handledNatives} from '../src/runtime/native-registry.mjs';
import {gameDirectory} from './game-directory.mjs';

// Inspect the engine/game/UI script packages, without loading unrelated audio
// payloads or treating the existence of a declaration as native compatibility.
// Which natives Play handles comes from src/runtime/native-registry.mjs, which
// test/native-registry.test.mjs keeps equal to the dispatchers' code; the per-
// native census (every declaration, who calls it, what is missing by family)
// is scripts/census-natives.mjs (docs/native-census.md). This script keeps the
// package statistics, the opcode counts and the direct call counts.
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
// Support means a dispatch path: any index the registry lists (the VM's primitive operators and every dispatcher of the
// invokeNative chain). A listed index may be partial or conditional (native-registry.mjs `partial`, `when`).
const supportedDirectNativeIndices=new Set(handledNatives().byIndex.keys());
const directNativeTotals=new Map();
for(const pkg of packages)for(const [index,count] of Object.entries(pkg.directNativeCalls))
  directNativeTotals.set(Number(index),(directNativeTotals.get(Number(index))??0)+count);
const unsupportedDirectNativeCalls=[...directNativeTotals]
  .filter(([index])=>!supportedDirectNativeIndices.has(index))
  .sort((a,b)=>b[1]-a[1]||a[0]-b[0])
  .map(([index,count])=>({index,count}));
const report={packages,
  directNativeSummary:{
  totalCalls:[...directNativeTotals.values()].reduce((sum,count)=>sum+count,0),
  distinctIndices:directNativeTotals.size,
  supportedDistinctIndices:[...directNativeTotals.keys()].filter(index=>supportedDirectNativeIndices.has(index)).length,
  unsupportedDistinctIndices:unsupportedDirectNativeCalls.length,
  unsupportedDirectNativeCalls},finalNativeCalls:[...finalCalls].flatMap(([key,count])=>
  declarations.has(key)?[{...declarations.get(key),count}]:[]),
  note:'Declarations and decoded opcodes do not establish execution support. Supported direct indices are those src/runtime/native-registry.mjs lists (checked against the dispatchers by test/native-registry.test.mjs); a listed index can be partial or conditional. directNativeSummary ranks the remaining direct indices by decoded call count over the packages named here only; scripts/census-natives.mjs covers every package and the calls by name, and docs/native-census.md the families.'};
const output=path.resolve(process.argv[2]??'.cache/script-runtime-inventory.json');
await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({report:output,packages:packages.map(p=>({name:p.name,classes:p.classes,
  functions:p.functions,states:p.states,nativeDeclarations:p.nativeDeclarations.length,
  directNativeIndices:Object.keys(p.directNativeCalls).length,decodeErrors:p.decodeErrors.length})),
  directNativeSummary:{totalCalls:report.directNativeSummary.totalCalls,
    distinctIndices:report.directNativeSummary.distinctIndices,
    supportedDistinctIndices:report.directNativeSummary.supportedDistinctIndices,
    unsupportedDistinctIndices:report.directNativeSummary.unsupportedDistinctIndices,
    unsupportedDirectNativeCalls:unsupportedDirectNativeCalls.reduce((sum,{count})=>sum+count,0),
    topUnsupportedDirectNativeCalls:unsupportedDirectNativeCalls.slice(0,20)}},null,2));
if(packages.some(p=>p.decodeErrors.length))process.exitCode=1;
