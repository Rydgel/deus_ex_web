import fs from 'node:fs';import {spawnSync} from 'node:child_process';import {walking} from '../src/runtime/walking.mjs';
const f=Math.fround;
export function walkingCases(){
 const clear={time:1,normal:[0,0,0]},floor={time:2/27,normal:[0,0,1]},many=x=>Array.from({length:64},()=>x);
 const base={position:[0,0,45],velocity:[100,0,7],acceleration:[0,0,2],groundSpeed:320,accelRate:1024,maxStepHeight:25,friction:8,gravity:[0,0,-950],zoneVelocity:[0,0,0],dt:.016,moves:many(clear),lines:many(floor)};
 const mods=[{}, {velocity:[0,0,0]}, {dt:.1},{dt:.2},{dt:.4},{iterations:7,dt:.1},{iterations:8},{acceleration:[1000,500,99]}, {walking:true,acceleration:[1000,500,99]}, {zoneVelocity:[30,-15,5]}, {lines:many(clear)}, {dt:.1,lines:many(clear)}, {base:false,moves:[clear,floor,...many(clear)]}, {lines:many({...floor,time:1/27})}, {hitSlopedWall:true},{lines:many(clear),denyFall:true},{moves:[{time:.25,normal:[-1,0,0]},clear,{time:.25,normal:[-1,0,0]},...many(clear)],wallPhysics:2},{moves:[{...clear,justTeleported:true},...many(clear)],zoneVelocity:[30,0,0]}];
 for(const distance of [1.89999,1.9,1.90001,2.39999,2.4,2.40001])mods.push({lines:many({...floor,time:distance/27}),moves:[clear,floor,...many(clear)]});
 for(const distance of [4.09999,4.1,4.3,4.6,4.60001])mods.push({velocity:[0,0,0],lines:[{...floor,time:distance/20},...many(floor)]});
 for(const normal of [[-1,0,0],[-.8,0,.6],[0,0,1]])mods.push({moves:[{time:.25,normal},clear,clear,floor,...many(clear)]});
 for(const normal of [[-.8,0,.6],[0,0,1],[0,0,0]])mods.push({hitSlopedWall:true,lines:[{time:.5,normal},...many(floor)]});
 for(const friction of [.2,.5,2,4,8])mods.push({friction,lines:many({time:2/27,normal:[.6,0,.8]})});
 for(const dt of [.01,.033,.1])mods.push({dt,position:[124.412,-56.334,102],acceleration:[414,-819,0],velocity:[-153,66,0]});
 return mods.map(m=>({...base,...m}));
}

export function run(c){
 const events=[];let mi=0,li=0;const actor={};
 const pawn={...structuredClone(c),position:c.position.map(f),velocity:c.velocity.map(f),acceleration:c.acceleration.map(f),radius:20,height:43,physics:1,base:c.base===false?null:actor,canJump:true,isPlayer:true,isWalking:!!c.walking,hitSlopedWall:!!c.hitSlopedWall,mass:150,
 walkingPrelude(dt,it){events.push({prelude:dt,iterations:it});return false;},
 move(delta){events.push({move:delta,velocity:[...this.velocity]});const r=c.moves[mi++];if(r.justTeleported)this.justTeleported=true;this.position=this.position.map((v,i)=>f(v+f(delta[i]*f(r.time))));return {...r,time:f(r.time),normal:r.normal.map(f),actor:r.time<1?actor:null};},
 lineCheck(start,end,extent,flags){events.push({line:{start:[...start],end,extent,flags}});const r=c.lines[li++];return {...r,time:f(r.time),normal:r.normal.map(f),actor:r.time<1?actor:null};},
 setSupportBase(a){this.base=a;events.push({base:!!a});},setPhysics(p){this.physics=p;events.push({physics:p});},
 farMove(pos){this.position=[...pos];events.push({farMove:pos});},mayFall(){events.push({event:'MayFall'});if(c.denyFall)this.canJump=false;},fallingEvent(){events.push({event:'Falling'});},falling(dt,it){events.push({falling:dt,iterations:it});},hitWall(h){events.push({wall:h.normal});if(c.wallPhysics)this.physics=c.wallPhysics;}};
 walking(pawn,c.dt,c.iterations??0);return Object.fromEntries(['position','velocity','acceleration','physics','hitSlopedWall'].map(k=>[k,pawn[k]]).concat([['events',events]]));
}
if(process.argv[1] && new URL(import.meta.url).pathname===process.argv[1]) {
fs.mkdirSync('.cache/walking',{recursive:true});
if(!process.argv[2])fs.writeFileSync('.cache/walking/cases.json',JSON.stringify(walkingCases()));
const cases=JSON.parse(fs.readFileSync(process.argv[2]??'.cache/walking/cases.json'));
if(!process.argv[3]){const r=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-walking-oracle.py',process.env.DEUS_EX_ROOT??'Deus Ex GOTY Edition',process.argv[2]??'.cache/walking/cases.json'],{encoding:'utf8'});if(r.status)throw Error(r.stderr);fs.writeFileSync('.cache/walking/native.json',r.stdout);}
const native=JSON.parse(fs.readFileSync(process.argv[3]??'.cache/walking/native.json')).results;
const actual=cases.map(run),failures=[];
for(let i=0;i<cases.length;i++)if(JSON.stringify(actual[i])!==JSON.stringify(native[i]))failures.push({i,actual:actual[i],expected:native[i]});
fs.writeFileSync('.cache/walking/comparison.json',JSON.stringify({cases:cases.length,failures},null,2));console.log(JSON.stringify({cases:cases.length,failures:failures.length,first:failures.slice(0,2)},null,2));process.exitCode=failures.length?1:0;

}
