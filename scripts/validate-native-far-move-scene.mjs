import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gameDirectory} from './game-directory.mjs';
const reuse=process.argv.includes('--reuse'),captureOnly=process.argv.includes('--capture-only');
for(const name of ['00_Training','01_NYC_UNATCOIsland']){
 const dir=`reports/movement/native-far-move-scene/${name}`;await mkdir(dir,{recursive:true});let scene,cases;
 if(reuse){scene=JSON.parse(await readFile(dir+'/scene.json'));cases=JSON.parse(await readFile(dir+'/cases.json'));}
 else{
  scene=JSON.parse(await readFile(`reports/movement/native-level/${name}/scene.json`));
  const fit=JSON.parse(await readFile(`reports/movement/native-level/${name}/cases.json`)).fitting;
  const start=fit[0].position;
  scene.actors.push({id:'$pawn',kind:'Pawn',collisionBits:15,actorFlags:0x80000,values:{Location:start,CollisionRadius:20,CollisionHeight:43}});
  cases=[];
  for(const item of [fit[0],fit[1],fit[Math.floor(fit.length/3)],fit[Math.floor(fit.length*2/3)],fit.at(-1)])for(const [test,noCheck]of [[0,0],[1,0],[0,1]])cases.push({position:start,destination:item.position,height:item.extent[2],test,noCheck});
  for(const a of scene.actors.filter(a=>a.kind==='Pawn'&&a.id!=='$pawn').slice(0,2))for(const reject of [[],[a.id]])cases.push({position:start,destination:a.values.Location,reject});
  cases.push({position:start,destination:[0,0,-10000]});
  await writeFile(dir+'/scene.json',JSON.stringify(scene));await writeFile(dir+'/cases.json',JSON.stringify(cases));
 }
 let original;
 if(reuse)original=JSON.parse(await readFile(dir+'/original.json'));
 else{const r=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-far-move-scene-oracle.py',gameDirectory(),dir+'/scene.json',dir+'/cases.json'],{encoding:'utf8',maxBuffer:32*1024*1024});if(r.status!==0)throw Error(r.stderr);original=JSON.parse(r.stdout);await writeFile(dir+'/original.json',r.stdout);}
 for(const key of ['scene','cases'])assert.equal(original[key+'Sha256'],createHash('sha256').update(await readFile(dir+'/'+key+'.json')).digest('hex'));
 if(captureOnly){console.log(name,cases.length,'original cases captured');continue;}
 const {createLevelQueries}=await import('../src/runtime/level-queries.mjs'),{traceExtent}=await import('../src/runtime/extent-trace.mjs'),{findSpot}=await import('../src/runtime/fitting.mjs'),{farMoveActor}=await import('../src/runtime/relocation.mjs'),{checkPlayerEncroachment}=await import('../src/runtime/check-encroachment.mjs');
 const bits=new DataView(new ArrayBuffer(4));
 for(const model of [scene.model,...scene.actors.map(a=>a.model).filter(Boolean)])for(const node of model.nodes)if(node.planeBits)node.plane=node.planeBits.map(w=>{bits.setUint32(0,w,true);return bits.getFloat32(0,true);});
 for(const a of scene.actors){
  a.lineage??=['engine.actor',...(a.kind==='Pawn'?['engine.pawn']:a.kind==='Mover'?['engine.mover','engine.brush']:a.kind==='ZoneInfo'?['engine.zoneinfo']:[])];
  a.flags=a.collisionBits;a.actorFlags??=Number(Boolean(a.values.bStatic));a.physics=1;a.pawnFlags=a.id==='$pawn'?2:0;a.isPawn=a.kind==='Pawn';a.controlledPlayer=a.id==='$pawn';a.movingBrush=Boolean(a.model);a.rotation=a.values.Rotation??[0,0,0];
  for(const [key,value]of [['position','Location'],['radius','CollisionRadius'],['height','CollisionHeight']])Object.defineProperty(a,key,{get(){return this.values[value]??0;},set(v){this.values[value]=v;}});
 }
 const queries=createLevelQueries(scene.model,scene.actors,{extentCheck:traceExtent}),pawn=scene.actors.find(a=>a.id==='$pawn'),mismatches=[];
 for(const a of scene.actors)a.worldActor=queries.levelInfo;
 cases.forEach((c,index)=>{
  queries.removeActor(pawn);for(const a of scene.actors)a.touching=[null,null,null,null];pawn.position=c.position.map(Math.fround);pawn.oldLocation=pawn.position.slice();pawn.height=Math.fround(c.height??43);pawn.motionFlags=0;queries.addActor(pawn);
  const events=[],dispatch=(a,event,[other])=>{events.push({event,actor:a.id,other:other.id});return event==='EncroachingOn'&&(c.reject??[]).includes(other.id);};
  const level={actors:scene.actors,netMode:0,editor:false,hash:{removeActor(a){events.push({event:'remove',position:a.position.slice()});queries.removeActor(a);},addActor(a){events.push({event:'add',position:a.position.slice()});queries.addActor(a);}},
   findSpot(extent,position,checkActors,checkFirst){events.push({event:'findSpot',position:position.slice(),extent});const result=findSpot(queries,position,extent,checkActors,checkFirst);if(result)position.splice(0,3,...result);return Boolean(result);},
   checkEncroachment(a,position,rotation,notify){events.push({event:'checkEncroachment',position:position.slice(),notify});return checkPlayerEncroachment(a,position,rotation,notify,{encroachmentCheck:queries.actorEncroachmentCheck,dispatch});},
   setActorZone(a,test,force){events.push({event:'zone',options:[test,force]});},setBase(){throw Error('Unexpected based child');}};
  const success=farMoveActor(level,pawn,c.destination,c.test??0,c.noCheck??0),touching=Object.fromEntries(scene.actors.filter(a=>a.touching.some(Boolean)).map(a=>[a.id,a.touching.map(x=>x?.id??null)]));
  const actual={success,position:pawn.position,oldLocation:pawn.oldLocation,motionFlags:pawn.motionFlags,events,touching};
  try{assert.deepEqual(actual,original.results[index]);}catch{mismatches.push({index,input:c,actual,expected:original.results[index]});}
 });
 const summary={name,cases:cases.length,mismatches};await writeFile(dir+'/comparison.json',JSON.stringify(summary));console.log(JSON.stringify({name,cases:cases.length,mismatchCount:mismatches.length,examples:mismatches.slice(0,2)}));assert.equal(mismatches.length,0);
}
