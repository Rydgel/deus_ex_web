import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {scriptFastTrace} from '../src/runtime/script-trace.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/fast-trace';await mkdir(directory,{recursive:true});
const cases=[];
for(const clear of [0,1,2,0x100,0x155])for(const explicit of [false,true]){
 const c={end:[40,50,60],clear};if(explicit)c.start=[1,2,3];cases.push(c);
}
for(const position of [[-1,-2,-3],[0.5,2.5,3.5]])cases.push({end:[40,50,60],clear:1,position});
await writeFile(`${directory}/cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')){
 const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-fast-trace-oracle.py',gameDirectory(),`${directory}/cases.json`],{encoding:'utf8'});
 if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/original.json`,native.stdout);
}
const original=JSON.parse(await readFile(`${directory}/original.json`,'utf8'));
assert.equal(original.results.length,cases.length);
for(const [index,c] of cases.entries()){
 const source={position:c.position??[10,20,30]},model={marker:true};
 let query;const check=(m,end,start)=>{assert.equal(m,model);query={end,start};return c.clear;};
 const result=scriptFastTrace(model,source,c.end,c.start,check);
 const expected=original.results[index];
 assert.deepEqual({query,result},{query:expected.query,result:expected.result!==0},`case ${index}`);
 // Binding level: invokeNative(548) evaluates End then the optional Start,
 // resolves Level->Model and masks the byte result through the same helper.
 const evalOrder=[];let boundQuery;const runtime=Object.create(ScriptRuntime.prototype);
 runtime.boundaryNatives=new Set();
 runtime.levelFor=()=>({model,fastLineCheck:(m,end,start)=>{assert.equal(m,model);boundQuery={end,start};return c.clear;}});
 const args=[c.end,c.start];
 const bound=runtime.invokeNative({index:548,argumentCount:2,receiver:source,evaluateArgument:i=>{evalOrder.push(i);return args[i];}});
 assert.deepEqual(evalOrder,[0,1],`eval order case ${index}`);
 assert.deepEqual({query:boundQuery,result:bound},{query:expected.query,result:expected.result!==0},`bound case ${index}`);
}
console.log(JSON.stringify({cases:cases.length,mismatches:0}));
