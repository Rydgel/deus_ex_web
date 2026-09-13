/** Validate Core UObject::Log native 231 against the hash-gated DLL oracle and
 * the logical runtime adapter.  The original oracle owns argument stepping,
 * default EName selection, the %s/GLog call, and temporary FString cleanup;
 * this script checks that the host boundary exposes the same observable data. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {execObjectLog,OBJECT_LOG_CONTRACT} from '../src/runtime/script-log.mjs';

const root=gameDirectory();
const python=process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python';
const native=JSON.parse(execFileSync(python,['scripts/native-object-log-oracle.py',root],{
  encoding:'utf8',maxBuffer:16*1024*1024,
}));

assert.deepEqual(native.hashes,{'Core.dll':OBJECT_LOG_CONTRACT.coreDllSha256});
assert.deepEqual(native.addresses,{
  thunk:OBJECT_LOG_CONTRACT.thunkAddress,
  body:OBJECT_LOG_CONTRACT.bodyAddress,
  logfBody:OBJECT_LOG_CONTRACT.logfAddress,
  reallocBody:0x10145440,
});
assert.deepEqual(native.tokens,{
  String:'0x1f',Name:'0x21',EndFunctionParms:'0x16',DefaultTag:'0x302',
});

const originalCases=native.cases;
assert.equal(originalCases.length,5);
for(const original of originalCases){
  assert.equal(original.codeAdvance,3);
  assert.equal(original.events.at(-1).kind,'logf');
  assert.equal(original.events.at(-1).format,OBJECT_LOG_CONTRACT.formatAddress);
  assert.equal(original.events.at(-1).formatText,'%s');
  assert.equal(original.events.at(-1).text,
    original.input.includes('\0')?original.input.split('\0',1)[0]:original.input);
  assert.equal(original.realloc.length,1);
  assert.equal(original.realloc[0].count,0);
  assert.equal(original.realloc[0].capacity,0);
  if(original.input.length===0){
    assert.equal(original.realloc[0].pointer,0);
    assert.equal(original.free.length,0);
    assert.equal(original.events.at(-1).textPointer,original.emptyStringAddress);
  }else{
    assert.equal(original.realloc[0].pointer,original.events.at(-1).textPointer);
    assert.deepEqual(original.free,[{pointer:original.events.at(-1).textPointer}]);
  }
  const expectedTag=original.tagOmitted?OBJECT_LOG_CONTRACT.defaultTagIndex:original.tagArgument;
  assert.equal(original.events.at(-1).tag,expectedTag);
  assert.deepEqual(original.events.slice(0,-1).map(event=>event.kind),
    original.tagOmitted?['string','end']:['string','name']);
}

function runAdapter(input,{tag,hasTag=false}={}){
  const evaluations=[];const events=[];
  const values=hasTag?[input,tag]:[input];
  const result=execObjectLog({argumentCount:values.length,evaluateArgument(index){
    evaluations.push(index);return values[index];
  }},{logDevice:event=>events.push(event)});
  return {result,evaluations,events};
}

for(const original of originalCases){
  const suppliedTagText={0x2f8:'Log',0x302:'ScriptLog'}[original.tagArgument];
  const result=runAdapter(original.input,{tag:suppliedTagText,hasTag:!original.tagOmitted});
  assert.equal(result.result,undefined);
  assert.deepEqual(result.evaluations,original.tagOmitted?[0]:[0,1]);
  assert.ok(original.tagOmitted||suppliedTagText,`missing logical name fixture for ${original.tagArgument}`);
  assert.deepEqual(result.events,[{
    text:original.input.includes('\0')?original.input.split('\0',1)[0]:original.input,
    tag:original.tagOmitted?OBJECT_LOG_CONTRACT.defaultTag:suppliedTagText,
    tagIndex:original.tagOmitted?OBJECT_LOG_CONTRACT.defaultTagIndex:null,
  }]);
}

const evaluations=[];const missingService={argumentCount:2,evaluateArgument(index){
  evaluations.push(index);return index===0?'message':'TagName';
}};
assert.throws(()=>execObjectLog(missingService),/synchronous GLog output device/);
assert.deepEqual(evaluations,[0,1]);
assert.throws(()=>execObjectLog({argumentCount:0,evaluateArgument:()=>''},{logDevice:()=>{}}),/requires a string/);
assert.throws(()=>execObjectLog({argumentCount:3,evaluateArgument:()=>''},{logDevice:()=>{}}),/optional name tag/);
assert.throws(()=>execObjectLog({argumentCount:2,evaluateArgument:index=>index?'bad\0name':'ok'},
  {logDevice:()=>{}}),/resolved logical FName/);
assert.throws(()=>execObjectLog({argumentCount:1,evaluateArgument:()=>42},
  {logDevice:()=>{}}),/typed string text/);
assert.throws(()=>execObjectLog({argumentCount:1,evaluateArgument:()=>''},
  {logDevice:()=>Promise.resolve()}),/synchronous GLog/);

const runtimeEvents=[];const runtime=new ScriptRuntime({},
  {logDevice:event=>runtimeEvents.push(event)});
const runtimeEvaluations=[];
runtime.invokeNative({index:231,receiver:{},argumentCount:2,evaluateArgument:index=>{
  runtimeEvaluations.push(index);return index===0?'runtime message':'RuntimeTag';
}});
assert.deepEqual(runtimeEvaluations,[0,1]);
assert.deepEqual(runtimeEvents,[{text:'runtime message',tag:'RuntimeTag',tagIndex:null}]);

const files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files),core=await assets.get('Core');
const metadata=readFunctionMetadata(core,core.exportsByPath.get('object.log'));
assert.equal(metadata.nativeIndex,231);
assert.equal(metadata.scriptSize,10);
assert.deepEqual([...metadata.script.bytes],[0x29,0x3e,0x29,0x3b]);
assert.deepEqual(metadata.parameters.filter(parameter=>!parameter.return).map(parameter=>
  [parameter.name,parameter.type,parameter.optional,parameter.coerce]),[
  ['S','string',false,true],['Tag','name',true,false],
]);

const coreDll=await readFile(`${root}/System/Core.dll`);
const imageBase=0x10100000;
const bytesAt=(address,length)=>[...coreDll.subarray(address-imageBase,address-imageBase+length)];
assert.deepEqual(bytesAt(OBJECT_LOG_CONTRACT.thunkAddress,5),[0xe9,0x0c,0x99,0x03,0x00]);
assert.deepEqual(bytesAt(OBJECT_LOG_CONTRACT.bodyAddress,8),[0x6a,0xff,0x68,0x3a,0x1a,0x17,0x10,0x64]);
assert.deepEqual(bytesAt(OBJECT_LOG_CONTRACT.logfAddress,8),[0xb8,0x00,0x20,0x00,0x00,0xe8,0x16,0x9c]);
assert.deepEqual(bytesAt(OBJECT_LOG_CONTRACT.formatAddress,4),[0x25,0x00,0x73,0x00]);

console.log(`Original Core.dll Object.Log native 231 passed ${originalCases.length} FFrame/default-tag/Logf/FString cases and runtime boundary checks.`);
