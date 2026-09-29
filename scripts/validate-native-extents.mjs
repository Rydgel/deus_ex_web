import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ClassDefaults} from '../src/unreal/classes.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {readModel} from '../src/unreal/model.mjs';
import {brushCollisionBounds} from '../src/runtime/brush-bounds.mjs';
import {brushToWorld} from '../src/runtime/coords.mjs';
import {nativeModel} from './native-model.mjs';
import {gameDirectory} from './game-directory.mjs';
import { loadTraceKernel } from '../src/runtime/trace-kernel.mjs';
await loadTraceKernel(); // Rust BSP traces; TRACE_KERNEL=js runs the JavaScript bodies
const root=gameDirectory(),f=Math.fround,captureOnly=process.argv.includes('--capture-only'),reuse=process.argv.includes('--reuse');
const files=[];
for(const dir of ['Maps','System'])for(const name of await readdir(path.join(root,dir)))files.push({path:`${dir}/${name}`,read:()=>readFile(path.join(root,dir,name))});
const assets=new AssetStore(files),defaults=new ClassDefaults(assets),groups=[];
let state=713;const random=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/2**32);
const extents=[43,16].flatMap(z=>[1,.9,1.1].map(s=>[20,20,z].map(v=>f(v*s))));
for(const name of ['00_Training','01_NYC_UNATCOIsland']){
  const asset=await assets.get(name),map=decodeMap(asset.bytes),cases=[];
  const center=name==='00_Training'?[-1149.24353,825.84393,-80.2]:[0,0,0];
  for(const extent of extents)for(const delta of [[0,0,-27],[0,0,30],[25,0,0],[10,10,-1],[0,0,0]])for(const dz of [-50,0,20])cases.push({start:center.map((v,i)=>f(v+(i===2?dz:0))),delta,extent});
  for(let i=0;i<60;i++)cases.push({start:center.map((v,j)=>f(v+(random()*2-1)*(j===2?80:300))),delta:Array.from({length:3},()=>f((random()*2-1)*80)),extent:extents[i%extents.length]});
  for(const node of map.model.nodes.filter(n=>n.plane.slice(0,3).filter(v=>Math.abs(v)>.001).length>1).slice(0,12))for(const extent of extents){
    const n=node.plane.slice(0,3),square=n.reduce((sum,v)=>sum+v*v,0),center=n.map(v=>f(v*node.plane[3]/square));
    const distance=n.reduce((sum,v,i)=>sum+Math.abs(v)*extent[i],0)+30;
    cases.push({start:center.map((v,i)=>f(v+n[i]*distance)),end:center.map((v,i)=>f(v-n[i]*distance)),extent});
  }
  groups.push({name:`${name}-world`,model:map.model,cases});
  for(const actor of map.actors){
    const values=await defaults.forActor(asset,actor);
    if(!values.bIsMover||values.Brush<=0||!values.bBlockPlayers)continue;
    const model=readModel(asset.pkg,asset.bytes,values.Brush),cases=[];
    for(const fraction of [0,.5,1]){
      const owner={...values,Location:values.Location.map((v,i)=>f(v+(values['KeyPos[1]']?.[i]??0)*fraction)),Rotation:(values.Rotation??[0,0,0]).map((v,i)=>Math.trunc(v+(values['KeyRot[1]']?.[i]??0)*fraction))};
      const bounds=brushCollisionBounds(model,owner),center=bounds.min.map((v,i)=>f((v+bounds.max[i])/2));
      for(const extent of extents)for(let axis=0;axis<3;axis++){
        const start=[...center],end=[...center];start[axis]=f(bounds.min[axis]-extent[axis]-10);end[axis]=f(bounds.max[axis]+extent[axis]+10);
        cases.push({owner,start,end,extent});
      }
    }
    groups.push({name:`${name}-${actor.name}`,model,cases});
    if(name==='00_Training'&&actor.name==='DeusExMover16'){
      const probes=[];
      for(const Rotation of [[0,8192,0],[2049,7001,4097],[0,16384,0]])for(const scaling of [false,true]){
        const owner={...values,Rotation,...(scaling?{MainScale:{scale:[2,.5,-1]},PostScale:{scale:[.75,1.5,2]}}:{})};
        const bounds=brushCollisionBounds(model,owner),center=bounds.min.map((v,i)=>f((v+bounds.max[i])/2));
        for(let i=0;i<100;i++){
          const start=center.map((v,j)=>f(v+(random()*2-1)*(bounds.max[j]-bounds.min[j]+80))),end=center.map((v,j)=>f(v+(random()*2-1)*80));
          probes.push({owner,start,end,extent:extents[i%extents.length]});
        }
      }
      groups.push({name:'controlled-oblique-owner',model,cases:probes});
    }
  }
}
const summaries=[],prepared=[];
for(const group of groups){
 const directory=path.resolve('reports/movement/native-extents',group.name);await mkdir(directory,{recursive:true});
 const modelFile=path.join(directory,'model.json'),casesFile=path.join(directory,'cases.json');
 await writeFile(modelFile,JSON.stringify(nativeModel(group.model)));await writeFile(casesFile,JSON.stringify(group.cases));
 prepared.push({group,directory});
}
if(!reuse){
 // Each group's oracle run is independent — its own model/cases inputs and
 // its own original.json output — so the dozens of process spawns run across
 // a bounded worker set instead of serially.
 const python=process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',queue=[...prepared];
 // Each worker owns one oracle process at a time; under the validator sweep
 // NATIVE_ORACLE_JOBS bounds this so nested spawns share the machine's cores.
 const workers=Math.max(1,Math.min(Number(process.env.NATIVE_ORACLE_JOBS)||8,queue.length));
 await Promise.all(Array.from({length:workers},async()=>{
  let next;while((next=queue.shift())){
   const {stdout}=await promisify(execFile)(python,['scripts/native-extent-oracle.py',root,path.join(next.directory,'model.json'),path.join(next.directory,'cases.json')],{encoding:'utf8',maxBuffer:32*1024*1024});
   await writeFile(path.join(next.directory,'original.json'),stdout);
  }}));
}
const {traceExtent}=await import('../src/runtime/extent-trace.mjs');
for(const {group,directory} of prepared){
 const native=JSON.parse(await readFile(path.join(directory,'original.json'),'utf8'));
 if(captureOnly){console.log(group.name,group.cases.length,'captured');continue;}
 const mismatches=[],comparisons=[];
 group.cases.forEach((c,i)=>{const expected=native.results[i],end=c.end??c.start.map((v,j)=>f(v+c.delta[j])),actual=traceExtent(group.model,c.start,end,c.extent,c.owner?brushToWorld(c.owner):null),reasons=[];
 if(!actual!==expected.line.outside)reasons.push('outside');
 if(actual&&!expected.line.outside&&actual.node!==expected.node)reasons.push('leaf node');
 if(actual&&!expected.line.outside)for(const key of ['time','normal','location']){const a=key==='time'?[actual[key]]:actual[key],b=key==='time'?[expected.line[key]]:expected.line[key];if(a.some((v,j)=>!Object.is(v,b[j])))reasons.push(key);}
 if(reasons.length)mismatches.push({index:i,reasons});comparisons.push({input:c,expected,actual});});
 const summary={name:group.name,cases:group.cases.length,hits:native.results.filter(r=>!r.line.outside).length,mismatches};summaries.push(summary);
 await writeFile(path.join(directory,'comparison.json'),JSON.stringify({summary,comparisons}));console.log(JSON.stringify({...summary,mismatches:mismatches.slice(0,3),mismatchCount:mismatches.length}));
}
if(!captureOnly){await writeFile('reports/movement/native-extents/summary.json',JSON.stringify(summaries));assert.equal(summaries.reduce((n,s)=>n+s.mismatches.length,0),0);}
