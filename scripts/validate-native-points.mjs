import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {decodeMap} from '../src/unreal/map.mjs';
import {nativeModel} from './native-model.mjs';
import {gameDirectory} from './game-directory.mjs';
const root=gameDirectory(),captureOnly=process.argv.includes('--capture-only'),reuse=process.argv.includes('--reuse');
const summaries=[];
for(const name of ['00_Training','01_NYC_UNATCOIsland']){
 const map=decodeMap(await readFile(path.join(root,'Maps',`${name}.dx`))),unique=new Map();
 const add=p=>{const c={position:p.position,extent:p.extent,extraNodeFlags:p.extraNodeFlags??p.extra??0};unique.set(JSON.stringify(c),c);};
 const directory=path.resolve('reports/movement/native-points',name);await mkdir(directory,{recursive:true});
 // Retain regressions when the composed comparison becomes clean after repair.
 try {for(const c of JSON.parse(await readFile(path.join(directory,'regression-cases.json'))))add(c);} catch(e) {if(e.code!=='ENOENT')throw e;}
 const composed=JSON.parse(await readFile(`reports/movement/native-level/${name}/comparison.json`));
 for(const m of composed.mismatches)for(const side of ['actual','expected'])for(const e of m[side].events??[])if(e.point)add(e.point);
 await writeFile(path.join(directory,'regression-cases.json'),JSON.stringify([...unique.values()]));
 const regressionCases=unique.size;
 const world=JSON.parse(await readFile(`reports/movement/native-world-fitting/${name}/original.json`));
 for(const r of world.results)for(const e of r.events??[])if(e.point)add(e.point);
 // Captured original fitting events cover required pawn sizes. Add exact-contact
 // and near-contact world queries from previously captured extent endpoints.
 const sweeps=JSON.parse(await readFile(`reports/movement/native-extents/${name}-world/cases.json`));
 for(const c of sweeps){add({position:c.start,extent:c.extent});}
 const cases=reuse?JSON.parse(await readFile(path.join(directory,'cases.json'))):[...unique.values()];
 await writeFile(path.join(directory,'model.json'),JSON.stringify(nativeModel(map.model)));await writeFile(path.join(directory,'cases.json'),JSON.stringify(cases));
 let reference;
 if(reuse)reference=JSON.parse(await readFile(path.join(directory,'original.json')));
 else{const r=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-point-oracle.py',root,path.join(directory,'model.json'),path.join(directory,'cases.json')],{encoding:'utf8',maxBuffer:16*1024*1024});if(r.status!==0)throw Error(r.stderr);await writeFile(path.join(directory,'original.json'),r.stdout);reference=JSON.parse(r.stdout);}
 if(captureOnly){console.log(name,cases.length,'captured',regressionCases,'regressions');continue;}
 const {pointCheck}=await import('../src/runtime/point-check.mjs'),mismatches=[];
 cases.forEach((c,i)=>{const actual=pointCheck(map.model,c.position,c.extent,c.extraNodeFlags);if(actual!==reference.outside[i])mismatches.push({index:i,input:c,actual,expected:reference.outside[i]});});
 const summary={name,cases:cases.length,regressionCases,overlaps:reference.outside.filter(v=>!v).length,mismatches};summaries.push(summary);await writeFile(path.join(directory,'comparison.json'),JSON.stringify(summary));console.log(JSON.stringify({...summary,mismatches:mismatches.slice(0,5),mismatchCount:mismatches.length}));
}
if(!captureOnly){await writeFile('reports/movement/native-points/summary.json',JSON.stringify(summaries));assert.equal(summaries.reduce((n,s)=>n+s.mismatches.length,0),0);}
