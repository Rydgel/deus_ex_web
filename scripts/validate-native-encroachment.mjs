import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {brushCollisionBounds,primitiveCollisionBounds} from '../src/runtime/brush-bounds.mjs';
import {gameDirectory} from './game-directory.mjs';
import {loadTraceKernel} from '../src/runtime/trace-kernel.mjs';
const kernel=await loadTraceKernel(); // the Rust twin of a brush's world box answers when loaded (TRACE_KERNEL=js: the reference)
const f=Math.fround,reuse=process.argv.includes('--reuse'),captureOnly=process.argv.includes('--capture-only');
const poses=JSON.parse(await readFile('reports/movement/native-bounds/cases.json')),summaries=[];
for(const name of ['00_Training','01_NYC_UNATCOIsland']){
 const directory=path.resolve('reports/movement/native-encroachment',name);await mkdir(directory,{recursive:true});
 let scene,cases;
 if(reuse){scene=JSON.parse(await readFile(path.join(directory,'scene.json')));cases=JSON.parse(await readFile(path.join(directory,'cases.json')));}
 else{
  scene=JSON.parse(await readFile(`reports/movement/native-level/${name}/scene.json`));
  scene.actors.push({id:'$pawn',kind:'Pawn',collisionBits:15,actorFlags:0x80000,values:{Location:[0,0,0],CollisionRadius:20,CollisionHeight:43}});
  const first=scene.actors.find(a=>a.model);scene.actors.push({...structuredClone(first),id:'$staticBrush',actorFlags:1});
  cases=[];
  for(const actor of scene.actors.filter(a=>a.model&&a.id!=='$staticBrush'))for(const fraction of [0,.5,1]){
   const owner=poses.find(c=>c.name===`${name}/${actor.id}/${fraction}`).owner;
   const bounds=brushCollisionBounds(actor.model,owner),center=bounds.min.map((v,i)=>f((v+bounds.max[i])/2));
   for(const sign of [-1,1])cases.push({actor:actor.id,position:owner.Location,rotation:owner.Rotation??[0,0,0],pawnPosition:[f((sign<0?bounds.min[0]:bounds.max[0])+sign*10),center[1],center[2]],extra:sign<0?0:0xffffffff});
   if(fraction===0)cases.push({actor:'$pawn',position:center,rotation:[0,0,0]});
  }
  await writeFile(path.join(directory,'scene.json'),JSON.stringify(scene));await writeFile(path.join(directory,'cases.json'),JSON.stringify(cases));
 }
 let original;
 if(reuse)original=JSON.parse(await readFile(path.join(directory,'original.json')));
 else{const r=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-encroachment-oracle.py',gameDirectory(),path.join(directory,'scene.json'),path.join(directory,'cases.json')],{encoding:'utf8',maxBuffer:32*1024*1024});if(r.status!==0)throw Error(r.stderr);await writeFile(path.join(directory,'original.json'),r.stdout);original=JSON.parse(r.stdout);}
 for(const field of ['scene','cases'])assert.equal(original[field+'Sha256'],createHash('sha256').update(await readFile(path.join(directory,field+'.json'))).digest('hex'));
 if(captureOnly){console.log(name,cases.length,'captured');continue;}
 const {createCollisionHash}=await import('../src/runtime/collision-hash.mjs'),{actorEncroachmentCheck}=await import('../src/runtime/encroachment-query.mjs');
 const bits=new DataView(new ArrayBuffer(4));for(const a of scene.actors)if(a.model)for(const n of a.model.nodes)if(n.planeBits)n.plane=n.planeBits.map(w=>{bits.setUint32(0,w,true);return bits.getFloat32(0,true);});
 const hash=createCollisionHash(),bounds=a=>a.model?brushCollisionBounds(a.model,a.values):primitiveCollisionBounds(null,a.values);
 for(const a of scene.actors){a.lineage=a.kind==='Mover'?['engine.mover','engine.brush','engine.actor']:['engine.actor'];hash.addActor(a,bounds(a),{location:a.values.Location});}
 const mismatches=[];
 cases.forEach((c,i)=>{
  if(c.pawnPosition){const a=scene.actors.find(a=>a.id==='$pawn');hash.removeActor(a,bounds(a));a.values.Location=c.pawnPosition;hash.addActor(a,bounds(a),{location:a.values.Location});}
  const actor=scene.actors.find(a=>a.id===c.actor),hits=actorEncroachmentCheck(hash,actor,c.position,c.rotation,c.extra);
  const actual={hits:hits.map(h=>({outside:false,location:h.location,normal:h.normal,time:h.time,item:h.item,actor:h.actor.id,primitive:null})),positionAfter:actor.values.Location,rotationAfter:actor.values.Rotation??[0,0,0]};
  try{assert.deepEqual(actual,original.results[i]);}catch{mismatches.push({index:i,input:c,actual,expected:original.results[i]});}
 });
 const summary={name,cases:cases.length,mismatches};summaries.push(summary);await writeFile(path.join(directory,'comparison.json'),JSON.stringify(summary));console.log(JSON.stringify({...summary,mismatches:mismatches.slice(0,4),mismatchCount:mismatches.length}));
}
if(!captureOnly){await writeFile('reports/movement/native-encroachment/summary.json',JSON.stringify(summaries));assert.equal(summaries.reduce((n,s)=>n+s.mismatches.length,0),0);}
