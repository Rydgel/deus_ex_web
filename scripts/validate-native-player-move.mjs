import assert from'node:assert/strict';import{readFile,mkdir,writeFile}from'node:fs/promises';import{execFile}from'node:child_process';import{promisify}from'node:util';import path from'node:path';import{gameDirectory}from'./game-directory.mjs';import{playerMove}from'../src/runtime/player-move.mjs';
const scene=JSON.parse(await readFile('reports/movement/mover-move/scene.json','utf8'));scene.actors=scene.actors.filter(a=>a.kind==='Mover');
for(const [id,Location,collisionBits]of [['$player',[-300,800,-64],15],['$trigger',[-280,800,-64],1],['$blocker',[-250,840,-64],13]])scene.actors.push({id,kind:'Pawn',collisionBits,values:{Location,CollisionRadius:id==='$player'?17:8,CollisionHeight:42}});
const cases=[];for(const delta of [[0,0,0],[.00009,0,0],[100,0,0],[0,80,0],[0,0,-100],[10,0,0],[-10,0,0]])for(const start of [[-300,800,-64],[-240,800,-64],[-220,830,-64]])cases.push({start,delta});
cases.push({start:[-300,800,-64],delta:[100,0,0],static:true},{start:[-300,800,-64],delta:[100,0,0],touching:['$trigger',null,null,null]},{start:[-300,800,-64],delta:[10,0,0],touching:['$blocker',null,null,null]});
cases.push({start:[-300,800,-64],delta:[100,0,0],base:'DeusExMover16'},{start:[-300,800,-64],delta:[100,0,0],movable:false});
for(const flags of [1,3,5,9])cases.push({start:[-300,800,-64],delta:[100,0,0],flags});
const dir=path.resolve('reports/movement/player-move');await mkdir(dir,{recursive:true});const sceneFile=path.join(dir,'scene.json'),caseFile=path.join(dir,'cases.json');await writeFile(sceneFile,JSON.stringify(scene));await writeFile(caseFile,JSON.stringify(cases));
const{stdout}=await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON??'python3',['scripts/native-player-move-oracle.py',gameDirectory(),sceneFile,caseFile],{maxBuffer:16*1024*1024,timeout:120000});await writeFile(path.join(dir,'original.json'),stdout);const native=JSON.parse(stdout),mismatches=[];
for(let i=0;i<cases.length;i++){
 const c=cases[i],expected=native.results[i],objects=new Map(scene.actors.map(a=>[a.id,{id:a.id,flags:a.collisionBits,position:[...a.values.Location],rotation:a.values.Rotation??[0,0,0],movingBrush:a.kind==='Mover',controlledPlayer:a.id==='$player',radius:a.values.CollisionRadius,height:a.values.CollisionHeight,movable:true,standingCount:0,base:null}]));
 const world={id:'$world'};objects.set('$world',world);const source=objects.get('$player');Object.assign(source,{position:c.start,static:!!c.static,movable:c.movable!==false,flags:c.flags??15,base:objects.get(c.base)??null,touching:(c.touching??[null,null,null,null]).map(id=>objects.get(id)??null)});
 const hits=expected.hits.map(h=>({...h,actor:objects.get(h.actor)})),events=[];let cursor=0;
 const log=e=>{const want=expected.events[cursor++];assert.deepEqual(e,want);events.push(e);};
 const policy=(kind,other)=>{const want=expected.events[cursor];log({[kind]:other.id,position:[...source.position],result:want.result});return want.result;};
 const result=playerMove(source,c.delta,{worldActor:world,multiLineCheck:()=>hits,
  removeActor:actor=>log({hash:'remove',actor:actor.id,position:[...source.position]}),addActor:actor=>log({hash:'add',actor:actor.id,position:[...source.position]}),
  dispatch:(actor,event,args)=>log({event,actor:actor.id,position:[...source.position],args:args.map(x=>Array.isArray(x)?x:x.id)}),
  isBlockedBy:(a,b)=>policy('blocked',b),isOverlapping:(a,b)=>policy('overlap',b),
  beginTouch:(a,b)=>log({touch:'begin',actor:b.id,position:[...source.position]}),endTouch:(a,b,flag)=>{assert.equal(flag,false);log({touch:'end',actor:b.id,position:[...source.position]});},
  setActorZone:(a,test,force)=>log({zone:a.id,test:Number(test),force:Number(force),position:[...source.position]})});
 try{assert.equal(result.success,expected.success);assert.equal(result.time,expected.time);assert.deepEqual(result.position,expected.position);assert.equal(result.hit?.actor?.id??null,expected.hitActor);assert.equal(cursor,expected.events.length);}catch(e){mismatches.push({i,message:e.message});}
}
await writeFile(path.join(dir,'comparison.json'),JSON.stringify({cases:cases.length,hashes:native.hashes,mismatches},null,2));console.log({cases:cases.length,mismatches});assert.equal(mismatches.length,0);
