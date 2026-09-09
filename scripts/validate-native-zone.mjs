import{readFile,writeFile,mkdir,readdir}from'node:fs/promises';
import{spawnSync}from'node:child_process';
import assert from'node:assert/strict';
import{gameDirectory}from'./game-directory.mjs';
import{AssetStore}from'../src/unreal/assets.mjs';
import{ClassDefaults}from'../src/unreal/classes.mjs';
import{decodeMap}from'../src/unreal/map.mjs';
import{nativeModel}from'./native-model.mjs';
const directory='.cache/zone';await mkdir(directory,{recursive:true});
const base={regions:[{zone:'a'},{zone:'b'},{zone:'c'}]};
const cases=[base,{...base,test:1},{...base,deleted:true},{...base,pri:true},{...base,pri:true,netMode:3},{...base,force:1,region:{zone:'a',leaf:99,zoneNumber:1},footRegion:{zone:'b',leaf:99,zoneNumber:2},headRegion:{zone:'c',leaf:99,zoneNumber:3}},{...base,regions:[{zone:'world'},{zone:'world'},{zone:'world'}]},{...base,mutations:{zoneChange:{position:[5,6,7],height:16},footChange:{baseEyeHeight:13}}}];
for(const extra of [{},{test:1},{force:1,footRegion:{zone:'b',leaf:77,zoneNumber:2},headRegion:{zone:'c',leaf:88,zoneNumber:3}},{deleted:true},{pri:true},{regions:[{zone:'world',leaf:8,zoneNumber:4}]}])cases.push({...base,isPawn:false,...extra});
const node={plane:[0,0,1,0],zoneMask:[0,0],vertexPool:0,surface:0,back:-1,front:-1,coplanar:-1,collisionBound:-1,renderBound:-1,zones:[1,2],vertexCount:4,flags:0,leaves:[11,22]};
for(const z of[-1,0,1])for(const numZones of[0,4])cases.push({type:'point',position:[0,0,z],numZones,model:{rootOutside:1,leafHulls:[],nodes:[node]}});
cases.push({type:'point',position:[1,2,3],model:{rootOutside:1,leafHulls:[],nodes:[]}});
cases.push({type:'point',position:[0,0,1],zoneActors:['world',null,null],model:{rootOutside:1,leafHulls:[],nodes:[node]}});
const root=gameDirectory(),files=[];for(const dir of['Maps','System'])for(const n of await readdir(`${root}/${dir}`))files.push({path:`${dir}/${n}`,read:()=>readFile(`${root}/${dir}/${n}`)});
const assets=new AssetStore(files),defs=new ClassDefaults(assets);
for(const name of['00_Training','01_NYC_UNATCOIsland']){
 const a=await assets.get(name),map=decodeMap(a.bytes);let count=0;
 const zoneActors=map.model.zones.map(z=>{if(!z.actor)return null;const actor=map.actors.find(a=>a.index===z.actor);return actor?.name.toLowerCase().includes('water')?'a':'b';});
 for(const actor of map.actors){if(!actor.name.startsWith('PlayerStart'))continue;const v=await defs.forActor(a,actor);
  for(const dz of[0,-43,40])cases.push({type:'point',map:name,position:v.Location.map((x,i)=>Math.fround(x+(i===2?dz:0))),numZones:zoneActors.length,zoneActors,model:nativeModel(map.model)});
  if(++count===2)break;
 }
}
await writeFile(`${directory}/cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')){const n=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-zone-oracle.py',root,`${directory}/cases.json`],{encoding:'utf8',maxBuffer:4e6});if(n.status!==0)throw Error(n.stderr);await writeFile(`${directory}/original.json`,n.stdout);}
const reference=JSON.parse(await readFile(`${directory}/original.json`,'utf8'));
if(process.argv.includes('--capture-only')){console.log(JSON.stringify({captured:cases.length}));process.exit(0);}
const{setActorZone,pointRegion}=await import('../src/runtime/zone.mjs');let mismatches=0;
for(const[i,c]of cases.entries()){
 let actual;
 if(c.type==='point')actual=pointRegion(c.model,c.position,'world',c.zoneActors??['world','a','b','c'],c.numZones??4);
 else{
  const p={isPawn:c.isPawn,position:c.position??[10,20,30],height:c.height??43,baseEyeHeight:c.baseEyeHeight??40,deleted:c.deleted,region:c.region??{zone:'world',leaf:-1,zoneNumber:0},footRegion:c.footRegion??{zone:'world',leaf:-1,zoneNumber:0},headRegion:c.headRegion??{zone:'world',leaf:-1,zoneNumber:0},playerReplicationInfo:c.pri?{playerZone:'world'}:null};
  const events=[];let index=0;const snapshot=()=>structuredClone({region:p.region,footRegion:p.footRegion,headRegion:p.headRegion});
  const event=name=>{events.push({event:name,...snapshot()});Object.assign(p,c.mutations?.[name]??{});};
  const callbacks={pointRegion(position){events.push({query:position});const n=index++;return{zone:c.regions[n].zone,leaf:c.regions[n].leaf??n+1,zoneNumber:c.regions[n].zoneNumber??n+1};},actorLeaving:()=>event('leaving'),zoneChange:()=>event('zoneChange'),actorEntered:()=>event('entered'),footZoneChange:()=>event('footChange'),headZoneChange:()=>event('headChange')};
  setActorZone(p,{levelInfo:'world',netMode:c.netMode??0,...callbacks},c.test??false,c.force??false);
  actual={...snapshot(),events,playerZone:p.playerReplicationInfo?.playerZone??'world'};
 }
 try{assert.deepEqual(actual,reference.results[i]);}catch{mismatches++;console.log(JSON.stringify({i,actual,expected:reference.results[i]}));}
}
console.log(JSON.stringify({cases:cases.length,mismatches}));if(mismatches)process.exitCode=1;
