import assert from'node:assert/strict';import{mkdir,writeFile}from'node:fs/promises';import{execFile}from'node:child_process';import{promisify}from'node:util';import path from'node:path';import{gameDirectory}from'./game-directory.mjs';import{moveSmooth}from'../src/runtime/move-smooth.mjs';
const cases=[];for(const delta of [[0,0,0],[1,2,3],[10,0,0],[-12.34,56.78,-.91]])for(const normal of [[1,0,0],[0,1,0],[.6,.8,0],[0,0,1]])for(const time of [0,.25,1])for(const result of [false,true])cases.push({delta,responses:[{normal,time,result},{normal:[0,1,0],time:.5,result:!result},{normal:[0,0,1],time:1,result:true}]});
cases.push({delta:[1,2,3],rotation:[0,4,0],eventRotation:[0,8,0],responses:[{normal:[1,0,0],time:.25,result:false},{normal:[0,1,0],time:.5,result:true},{normal:[0,0,1],time:1,result:true}]});
const dir=path.resolve('reports/movement/move-smooth');await mkdir(dir,{recursive:true});const file=path.join(dir,'cases.json');await writeFile(file,JSON.stringify(cases));const{stdout}=await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON??'python3',['scripts/native-move-smooth-oracle.py',gameDirectory(),file],{maxBuffer:16*1024*1024,timeout:120000});await writeFile(path.join(dir,'original.json'),stdout);const native=JSON.parse(stdout),mismatches=[];
if(process.argv.includes('--map')){
 const {stdout:mapOutput}=await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON??'python3',['scripts/native-map-move-smooth-oracle.py',gameDirectory(),path.resolve('reports/movement/mover-move/scene.json'),path.resolve('reports/movement/mover-move/cases.json')],{maxBuffer:16*1024*1024,timeout:120000});
 await writeFile(path.join(dir,'map-original.json'),mapOutput);const mapCases=JSON.parse(mapOutput).cases;
 for(const c of mapCases){cases.push(c);native.results.push({result:c.result,events:c.events});}
}
for(let i=0;i<cases.length;i++){
 const c=cases[i],actor={rotation:c.rotation??[0,0,0]},events=[];let index=0;
 const result=moveSmooth(actor,c.delta,{moveActor:(a,delta,rotation,flags)=>{assert.deepEqual(flags,[0,0,0,0]);events.push({move:delta,rotation});const r=c.responses[index++];return {...r,time:Math.fround(r.time),normal:r.normal.map(Math.fround),actor:{}};},dispatch:(a,e,args)=>{assert.equal(e,'HitWall');events.push({hitWall:args[0]});if(c.eventRotation)actor.rotation=c.eventRotation;}});
 const actual={result,events};try{assert.deepEqual(actual,native.results[i]);}catch{mismatches.push({i,actual,expected:native.results[i]});}
}
await writeFile(path.join(dir,'comparison.json'),JSON.stringify({cases:cases.length,hashes:native.hashes,mismatches},null,2));console.log(JSON.stringify({cases:cases.length,mismatches:mismatches.slice(0,4),mismatchCount:mismatches.length},null,2));assert.equal(mismatches.length,0);
