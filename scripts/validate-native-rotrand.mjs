/** Validate Core.Object.RotRand (native 320) against the unchanged Core.dll body. */

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {createNativeRng} from '../src/runtime/rng.mjs';
import {execRotRand,ROTRAND_NATIVE} from '../src/runtime/script-rot-rand.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),dir='reports/movement/native-rotrand',reuse=process.argv.includes('--reuse');
await mkdir(dir,{recursive:true});
let state=0x2545f491;
const nextSeed=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
const seeds=[0,1,42,32767,65535,2147483648,4294967295,1700000000,2708534849,4028364353,
  ...Array.from({length:23},()=>nextSeed())];
// Argument token streams before the terminating EX_EndFunctionParms: omitted
// trailing optional (as Projectile.RandSpin compiles `RotRand()`: 61 40 16),
// explicit EX_Nothing, EX_True and EX_False.
const argumentForms=[{tokens:[],argumentCount:0},{tokens:[0x0b],argumentCount:1,value:undefined},
  {tokens:[0x27],argumentCount:1,value:true},{tokens:[0x28],argumentCount:1,value:false}];
const cases=seeds.flatMap(seed=>argumentForms.map(form=>({seed,tokens:form.tokens})));
const casesPath=path.resolve(dir,'cases.json');
if(reuse)cases.splice(0,cases.length,...JSON.parse(await readFile(casesPath,'utf8')));
else await writeFile(casesPath,JSON.stringify(cases));

const python=process.env.NATIVE_PROBE_PYTHON??process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python';
let original;
if(reuse)original=JSON.parse(await readFile(path.resolve(dir,'original.json'),'utf8'));
else {
  const output=execFileSync(python,['scripts/native-rotrand-oracle.py',root,casesPath],{encoding:'utf8',maxBuffer:4*1024*1024});
  original=JSON.parse(output);
  await writeFile(path.resolve(dir,'original.json'),output);
}
assert.equal(original.casesSha256,createHash('sha256').update(await readFile(casesPath)).digest('hex'));

const coreDll=await readFile(`${root}/System/Core.dll`),coreU=await readFile(`${root}/System/Core.u`);
assert.equal(createHash('sha256').update(coreDll).digest('hex'),ROTRAND_NATIVE.coreSha256);
assert.equal(createHash('sha256').update(coreU).digest('hex'),'4fb22ee4e3a6868dfabb2b46b15fad8e5094f5fda5927a14ff11670a744ec36c');
assert.deepEqual(original.hashes,{'Core.dll':ROTRAND_NATIVE.coreSha256,
  'MSVCRT.dll':'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210'});
assert.deepEqual(original.addresses,{nativeIndex:320,cell:'0x101aa940',thunk:'0x10102ebe',body:'0x101391b0',gnativesSlot:'0x101f46b8'});
// Registration 0x10139271: mov eax,[0x101aa940]; ...; mov [0x101f46b8],eax — GNatives
// base 0x101f41b8 + 4*320. The cell holds the export thunk, which jumps to the body.
assert.equal(coreDll.subarray(0x39271,0x3929f).toString('hex'),
  'a140a91a10c705b8811f1040010000a3b8461f108815ff3c1f10c38b0d40a91a108815ff3c1f10890db8461f10c3');
assert.equal(coreDll.readUInt32LE(0xaa940),ROTRAND_NATIVE.thunk);
assert.equal(coreDll.subarray(0x2ebe,0x2ec3).toString('hex'),'e9ed620300');
assert.equal(createHash('sha256').update(coreDll.subarray(0x391b0,0x3923c)).digest('hex'),
  '8cce96f76d11b47e4e2d161ac6c9319485ba35c7edb69d14fb1d957714f04940');

const files=[];
for(const name of await readdir(`${root}/System`))files.push({path:name,read:()=>readFile(`${root}/System/${name}`)});
const core=await new AssetStore(files).get('Core');
const metadata=readFunctionMetadata(core,core.exportsByPath.get('object.rotrand'));
assert.equal(metadata.nativeIndex,320);
const [bRoll,returnValue]=metadata.parameters;
assert.equal(bRoll.name,'bRoll');assert.equal(bRoll.type,'bool');
assert.equal(returnValue.type,'struct');assert.ok(returnValue.return);

assert.equal(original.results.length,cases.length);
for(const result of original.results){
  const form=argumentForms.find(candidate=>candidate.tokens.join()===result.tokens.join());
  const expectedCalls=form.value===true?3:2;
  assert.equal(result.randomCalls,expectedCalls,`seed ${result.seed}: CRT rand calls`);
  // One argument token plus P_FINISH; EX_EndFunctionParms backs up its own step.
  assert.equal(result.codeAdvance,form.tokens.length+1,`seed ${result.seed}: FFrame cursor`);
  const rng=createNativeRng(result.initialState);let calls=0;const counted={...rng,rand:()=>{calls++;return rng.rand();}};
  const actual=execRotRand({argumentCount:form.argumentCount,evaluateArgument:()=>form.value},{rng:counted});
  assert.deepEqual(actual,result.rotator,`seed ${result.seed} tokens ${result.tokens}: rotator`);
  assert.equal(calls,result.randomCalls,`seed ${result.seed}: rand calls`);
  assert.equal(rng.state,result.state,`seed ${result.seed}: shared RNG state`);
}
console.log(`Original Core native 320 passed ${original.results.length} FFrame/RNG cases (${seeds.length} seeds x ${argumentForms.length} bRoll forms); `+
  'Yaw/Pitch/Roll draw order, 2*rand()%65535, bRoll gating and shared-stream state match.');
