/** Validate Core.Object.VRand (native 252) against the unchanged Core.dll body. */

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {createNativeRng} from '../src/runtime/rng.mjs';
import {execVRand} from '../src/runtime/script-vrand.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),dir='reports/movement/native-vrand',reuse=process.argv.includes('--reuse');
await mkdir(dir,{recursive:true});
let state=0x6d2b79f5;
const nextSeed=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
const cases=[0,1,42,32767,2147483648,4294967295,1700000000,2708534849,4028364353,
  ...Array.from({length:24},()=>nextSeed())].map(seed=>({seed}));
const casesPath=path.resolve(dir,'cases.json');
if(reuse)cases.splice(0,cases.length,...JSON.parse(await readFile(casesPath,'utf8')));
else await writeFile(casesPath,JSON.stringify(cases));

const python=process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python';
let original;
if(reuse)original=JSON.parse(await readFile(path.resolve(dir,'original.json'),'utf8'));
else {
  const output=execFileSync(python,['scripts/native-vrand-oracle.py',root,casesPath],{
    encoding:'utf8',maxBuffer:2*1024*1024,
  });
  original=JSON.parse(output);
  await writeFile(path.resolve(dir,'original.json'),output);
}
const casesBytes=await readFile(casesPath);
assert.equal(original.casesSha256,createHash('sha256').update(casesBytes).digest('hex'));

const coreDll=await readFile(`${root}/System/Core.dll`);
const coreU=await readFile(`${root}/System/Core.u`);
const CORE_HASH='8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4';
const CORE_U_HASH='4fb22ee4e3a6868dfabb2b46b15fad8e5094f5fda5927a14ff11670a744ec36c';
assert.equal(createHash('sha256').update(coreDll).digest('hex'),CORE_HASH);
assert.equal(createHash('sha256').update(coreU).digest('hex'),CORE_U_HASH);
assert.deepEqual(original.hashes,{
  'Core.dll':CORE_HASH,
  'MSVCRT.dll':'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210',
});
assert.deepEqual(original.addresses,{nativeIndex:252,thunk:'0x101031ed',body:'0x10139080',f32One:'0x10177f9c',f64One:'0x101765a8'});
assert.equal(coreDll.subarray(0x31ed,0x31f2).toString('hex'),'e98e5e0300');
const bodyHex='8b44240483ec18ff400ce8308efcffdcc0d8259c7f1710d95c2400e81f8efcffdcc0d8259c7f1710d95c2404e80e8efcffdcc0d8259c7f1710d9542408d84c2408d9442404d84c2404dec1d9442400d84c2400dec1dc1da8651710dfe0f6c44174a8d9442408d84c2408d9442404d84c240483ec08dec1d9442408d84c2408dec1dd1c24e8b1a1fcffdc3da86517108b442428d9c0d84c2408d95c24148b4c2414d9c0d84c240c8908d95c24188b542418d84c2410895004d95c241c8b4c241c89480883c420c20800';
assert.equal(coreDll.subarray(0x39080,0x39149).toString('hex'),bodyHex);
const constants=new DataView(coreDll.buffer,coreDll.byteOffset);
assert.equal(constants.getFloat32(0x77f9c,true),1);
assert.equal(constants.getFloat64(0x765a8,true),1);

const files=[];
for(const name of await readdir(`${root}/System`))files.push({path:name,read:()=>readFile(`${root}/System/${name}`)});
const core=await new AssetStore(files).get('Core');
const exportIndex=core.exportsByPath.get('object.vrand');
assert.ok(exportIndex,'missing Core.Object.VRand');
const metadata=readFunctionMetadata(core,exportIndex);
assert.equal(metadata.nativeIndex,252);
assert.equal(metadata.scriptSize,0);
assert.equal(metadata.parameters.filter(parameter=>!parameter.return).length,0);
assert.equal(metadata.parameters.find(parameter=>parameter.return)?.type,'struct');

assert.equal(original.results.length,cases.length);
for(const [index,result] of original.results.entries()){
  assert.equal(result.codeAdvance,1,`seed ${result.seed}: FFrame cursor increment`);
  assert.equal(result.randomCalls%3,0,`seed ${result.seed}: three appFrand calls per sample`);
  assert.ok(result.randomCalls>=3,`seed ${result.seed}: appFrand call count`);
  const rng=createNativeRng(result.initialState);
  const actual=execVRand(rng);
  assert.deepEqual(actual,result.vector,`seed ${result.seed}: vector`);
  assert.equal(rng.state,result.state,`seed ${result.seed}: shared RNG state`);
}

console.log(`Original Core native 252 passed ${original.results.length} FFrame/RNG cases; `+
  'rejection sampling, x87 normalization, float32 component stores and shared-stream state match.');
