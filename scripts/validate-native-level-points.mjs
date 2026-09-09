import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {brushCollisionBounds,primitiveCollisionBounds} from '../src/runtime/brush-bounds.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createCollisionHash} from '../src/runtime/collision-hash.mjs';
import {brushToWorld} from '../src/runtime/coords.mjs';
import {modelPointCheck} from '../src/runtime/point-check.mjs';
import {createLevelPoints} from '../src/runtime/level-points.mjs';
const captureOnly=process.argv.includes('--capture-only'),reuse=process.argv.includes('--reuse'),f=Math.fround;
const summaries=[];
const authoredBounds=JSON.parse(await readFile('reports/movement/native-bounds/cases.json'));
for(const name of ['00_Training','01_NYC_UNATCOIsland']){
 const directory=path.resolve('reports/movement/native-level-points',name);await mkdir(directory,{recursive:true});
 const sceneRaw=await readFile(`reports/movement/native-level/${name}/scene.json`),scene=JSON.parse(sceneRaw);
 const bits=new DataView(new ArrayBuffer(4));
 for(const model of [scene.model,...scene.actors.map(a=>a.model).filter(Boolean)])for(const node of model.nodes)if(node.planeBits)node.plane=node.planeBits.map(word=>{bits.setUint32(0,word,true);return bits.getFloat32(0,true);});
 let cases;
 if(reuse)cases=JSON.parse(await readFile(path.join(directory,'cases.json')));
 else {
  cases={models:[],points:[]};
  const prior=JSON.parse(await readFile(`reports/movement/native-points/${name}/cases.json`));
  for(const c of prior)cases.models.push({...c,flags:0});
  for(const actor of scene.actors){
   const b=actor.model?brushCollisionBounds(actor.model,actor.values):primitiveCollisionBounds(null,actor.values);
   const center=b.min.map((v,i)=>f((v+b.max[i])/2));
   for(const height of [43,16,f(43*f(1.1))]){
    const extent=[height===f(43*f(1.1))?22:20,height===f(43*f(1.1))?22:20,height];
    for(const sign of [-1,1]){const position=[f((sign<0?b.min[0]:b.max[0])+sign*extent[0]*.5),center[1],center[2]];
     cases.points.push({position,extent,checkActors:1,world:true,flags:0});
     if(actor.model)cases.models.push({actor:actor.id,position,extent,flags:0});
    }
   }
   if(actor.model)for(const fraction of [.5,1]){
    const captured=authoredBounds.find(c=>c.name===`${name}/${actor.id}/${fraction}`);
    if(!captured)throw Error(`Missing authored mover pose ${name}/${actor.id}/${fraction}`);
    const owner={Location:captured.owner.Location,Rotation:captured.owner.Rotation??[0,0,0]};
    const moved=brushCollisionBounds(actor.model,{...actor.values,...owner}),center=moved.min.map((v,i)=>f((v+moved.max[i])/2));
    for(const height of [43,16,f(43*f(1.1))])for(const sign of [-1,1]){
     const extent=[height===f(43*f(1.1))?22:20,height===f(43*f(1.1))?22:20,height];
     cases.models.push({actor:actor.id,owner,position:[f((sign<0?moved.min[0]:moved.max[0])+sign*extent[0]*.5),center[1],center[2]],extent,flags:0});
    }
   }
  }
  for(const c of cases.points.slice(0,8))for(const flags of [1,0x21,0xffffffff])for(const world of [false,true])cases.points.push({...c,flags,world,checkActors:world?0:1});
  await writeFile(path.join(directory,'cases.json'),JSON.stringify(cases));
 }
 await writeFile(path.join(directory,'scene.json'),sceneRaw);
 let original;
 if(reuse)original=JSON.parse(await readFile(path.join(directory,'original.json')));
 else{const result=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-level-points-oracle.py',gameDirectory(),path.join(directory,'scene.json'),path.join(directory,'cases.json')],{encoding:'utf8',maxBuffer:64*1024*1024});if(result.status!==0)throw Error(result.stderr);await writeFile(path.join(directory,'original.json'),result.stdout);original=JSON.parse(result.stdout);}
 assert.equal(original.sceneSha256,createHash('sha256').update(sceneRaw).digest('hex'));
 assert.equal(original.casesSha256,createHash('sha256').update(await readFile(path.join(directory,'cases.json'))).digest('hex'));
 if(captureOnly){console.log(name,cases.models.length,'models',cases.points.length,'points captured');continue;}
 const actors=scene.actors,world={id:'$world'},hash=createCollisionHash();
 for(const actor of actors)hash.addActor(actor,actor.model?brushCollisionBounds(actor.model,actor.values):primitiveCollisionBounds(null,actor.values),{location:actor.values.Location});
 const query=createLevelPoints(scene.model,hash,world),mismatches=[];
 const pack=(h,actor=null,primitive=null)=>({outside:h.outside,location:h.location,normal:h.normal,time:h.time,actor:actor?.id??null,item:h.item??-1,primitive});
 const compare=(kind,index,actual,expected)=>{try{assert.deepEqual(actual,expected);}catch{mismatches.push({kind,index,input:cases[kind][index],actual,expected});}};
 cases.models.forEach((c,i)=>{const actor=actors.find(a=>a.id===c.actor),model=actor?.model??scene.model;compare('models',i,pack(modelPointCheck(model,c.position,c.extent,actor?brushToWorld({...actor.values,...c.owner}):null,c.flags),actor,actor?.id??'$world'),original.models[i]);});
 cases.points.forEach((c,i)=>{
  const hits=query.multiPointCheck(c.position,c.extent,c.flags,c.world?world:null,c.checkActors),single=query.singlePointCheck(c.position,c.extent,c.flags,c.world?world:null,c.checkActors);
  const packed=h=>pack(h,h.actor,h.primitive?(h.actor.id):null);
  compare('points',i,{hits:hits.map(packed),single:single.hit?packed(single.hit):{outside:true,location:[0,0,0],normal:[0,0,0],time:1,actor:null,item:-1,primitive:null}},original.points[i]);
 });
 summaries.push({name,models:cases.models.length,points:cases.points.length,mismatches});
 console.log(JSON.stringify({...summaries.at(-1),mismatches:mismatches.slice(0,5),mismatchCount:mismatches.length}));
 await writeFile(path.join(directory,'comparison.json'),JSON.stringify(summaries.at(-1)));
}
if(!captureOnly){await writeFile('reports/movement/native-level-points/summary.json',JSON.stringify(summaries));assert.equal(summaries.reduce((n,s)=>n+s.mismatches.length,0),0);}
