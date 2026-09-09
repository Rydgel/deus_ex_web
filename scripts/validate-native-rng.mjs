import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gameDirectory} from './game-directory.mjs';
const dir='reports/movement/native-rng',reuse=process.argv.includes('--reuse');await mkdir(dir,{recursive:true});
const cases=reuse?JSON.parse(await readFile(dir+'/cases.json')):[0,1,42,32767,2147483648,4294967295,1700000000].map(seed=>({seed,ops:Array.from({length:36},(_,i)=>['rand','appRand','frand'][i%3])})).concat([2708534849,4028364353].map(seed=>({seed,ops:['frand','rand','appRand']})));
if(!reuse)await writeFile(dir+'/cases.json',JSON.stringify(cases));
let original;if(reuse)original=JSON.parse(await readFile(dir+'/original.json'));else{const r=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-rng-oracle.py',gameDirectory(),dir+'/cases.json'],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);original=JSON.parse(r.stdout);await writeFile(dir+'/original.json',r.stdout);}
assert.equal(original.casesSha256,createHash('sha256').update(await readFile(dir+'/cases.json')).digest('hex'));
if(process.argv.includes('--capture-only')){console.log(cases.length,'original sequences captured');process.exit(0);}
const {createNativeRng}=await import('../src/runtime/rng.mjs');
const mismatches=[];cases.forEach((c,i)=>{const rng=createNativeRng(c.seed),initialState=rng.state,values=c.ops.map(op=>{const value=op==='frand'?rng.frand():rng.rand();return {op,value:op==='frand'?{retained:value,float32:Math.fround(value)}:value,state:rng.state};});const actual={initialState,values};try{assert.deepEqual(actual,original.results[i]);}catch{mismatches.push({index:i,actual,expected:original.results[i]});}});
await writeFile(dir+'/comparison.json',JSON.stringify({sequences:cases.length,values:cases.reduce((n,c)=>n+c.ops.length,0),mismatches}));console.log({sequences:cases.length,mismatchCount:mismatches.length});assert.deepEqual(mismatches,[]);
