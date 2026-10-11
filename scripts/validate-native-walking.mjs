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
 // A script event during the forward MoveActor (or stepUp's HitWall) that
 // sets a Physics other than Swimming: the body continues (0x103cb466);
 // a ledge then takes the Falling event with Physics as left. The stepUp
 // Falling event that leaves PHYS_Flying runs 0x103cb343 (physFlying).
 const wall={time:.25,normal:[-1,0,0]};
 for(const physics of [0,2,4,5])for(const dt of [.016,.1])mods.push({moves:[{...clear,physics},...many(clear)],dt},{moves:[{...clear,physics},...many(clear)],lines:many(clear),dt});
 mods.push({moves:[{...wall,physics:4},clear,clear,floor,...many(clear)]},{moves:[{...wall,physics:0},clear,clear,floor,...many(clear)],dt:.1});
 mods.push({moves:[wall,clear,wall,...many(clear)],wallPhysics:4},{moves:[wall,clear,wall,...many(clear)],wallPhysics:0,dt:.1});
 for(const dt of [.016,.1,.01])mods.push({moves:[wall,clear,wall,...many(clear)],wallPhysics:2,fallingPhysics:4,airSpeed:420.5,dt});
 mods.push({moves:[wall,clear,wall,...many(clear)],wallPhysics:2,fallingPhysics:0,airSpeed:420.5,dt:.1});
 for(const fallingPhysics of [0,4])mods.push({lines:many(clear),fallingPhysics,airSpeed:420.5});
 // A script pawn (no APlayerPawn in its class chain): calcVelocity ignores bIsWalking and scales MaxSpeed by DesiredSpeed
 // (0x103cd7e2, 0x103cdf05); the PlayerPawn control with the same DesiredSpeed ignores it (a pawn is a PlayerPawn by default).
 for(const desiredSpeed of [.2,.296,1])for(const walking of [false,true])for(const dt of [.016,.03]){
  mods.push({scripted:true,desiredSpeed,walking,dt,velocity:[250,0,0],acceleration:[1000,500,0]},{scripted:false,desiredSpeed,walking,dt,velocity:[250,0,0],acceleration:[1000,500,0]},
   {scripted:true,desiredSpeed,walking,dt,velocity:[0,0,0],acceleration:[300,-800,0],lines:many(clear)},{scripted:true,desiredSpeed,walking,dt,velocity:[120,40,0],acceleration:[0,0,0]});
 }
 // Open: physWalking's other class tests, not translated for a script pawn (docs/visual-acceptance.md "Live scenes"). 0x103ca876..0x103ca8fa:
 // a remaining time over 0.05 s is cut into steps for a PlayerPawn, but for any other pawn only when (|V|*remaining)^2 > 400 (0x10431bd0);
 // 0x103ca697..0x103ca6e8: ZoneVelocity (|zv|^2 against 90000, 0x10431bd4) is read for a non-PlayerPawn. These cases run and are
 // reported, not asserted.
 for(const dt of [.1,.2])for(const velocity of [[250,0,0],[20,0,0]])mods.push({open:true,scripted:true,desiredSpeed:1,walking:false,dt,velocity,acceleration:[1000,500,0]});
 for(const zoneVelocity of [[30,-15,5],[400,0,0]])mods.push({open:true,scripted:true,desiredSpeed:1,walking:false,zoneVelocity,velocity:[250,0,0],acceleration:[1000,500,0]});
 return mods.map(m=>({...base,...m}));
}

export function run(c){
 const events=[];let mi=0,li=0;const actor={};
 const pawn={...structuredClone(c),position:c.position.map(f),velocity:c.velocity.map(f),acceleration:c.acceleration.map(f),radius:20,height:43,physics:1,base:c.base===false?null:actor,canJump:true,isPlayer:true,isPlayerPawn:!c.scripted,desiredSpeed:c.desiredSpeed??1,isWalking:!!c.walking,hitSlopedWall:!!c.hitSlopedWall,mass:150,
 walkingPrelude(dt,it){events.push({prelude:dt,iterations:it});return false;},
 move(delta){events.push({move:delta,velocity:[...this.velocity]});const r=c.moves[mi++];if(r.justTeleported)this.justTeleported=true;if(r.physics!==undefined)this.physics=r.physics;this.position=this.position.map((v,i)=>f(v+f(delta[i]*f(r.time))));return {...r,time:f(r.time),normal:r.normal.map(f),actor:r.time<1?actor:null};},
 lineCheck(start,end,extent,flags){events.push({line:{start:[...start],end,extent,flags}});const r=c.lines[li++];return {...r,time:f(r.time),normal:r.normal.map(f),actor:r.time<1?actor:null};},
 setSupportBase(a){this.base=a;events.push({base:!!a});},setPhysics(p){this.physics=p;events.push({physics:p});},
 farMove(pos){this.position=[...pos];events.push({farMove:pos});},mayFall(){events.push({event:'MayFall'});if(c.denyFall)this.canJump=false;},fallingEvent(){events.push({event:'Falling'});if(c.fallingPhysics!==undefined)this.physics=c.fallingPhysics;},falling(dt,it){events.push({falling:dt,iterations:it});},flying(dt,it){events.push({flying:dt,iterations:it});},hitWall(h){events.push({wall:h.normal});if(c.wallPhysics!==undefined)this.physics=c.wallPhysics;}};
 walking(pawn,c.dt,c.iterations??0);return Object.fromEntries(['position','velocity','acceleration','physics','hitSlopedWall'].map(k=>[k,pawn[k]]).concat([['events',events]]));
}
if(process.argv[1] && new URL(import.meta.url).pathname===process.argv[1]) {
fs.mkdirSync('.cache/walking',{recursive:true});
if(!process.argv[2])fs.writeFileSync('.cache/walking/cases.json',JSON.stringify(walkingCases()));
const cases=JSON.parse(fs.readFileSync(process.argv[2]??'.cache/walking/cases.json'));
if(!process.argv[3]){const r=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-walking-oracle.py',process.env.DEUS_EX_ROOT??'Deus Ex GOTY Edition',process.argv[2]??'.cache/walking/cases.json'],{encoding:'utf8'});if(r.status)throw Error(r.stderr);fs.writeFileSync('.cache/walking/native.json',r.stdout);}
const native=JSON.parse(fs.readFileSync(process.argv[3]??'.cache/walking/native.json')).results;
const actual=cases.map(run),failures=[],open=[];
for(let i=0;i<cases.length;i++)if(JSON.stringify(actual[i])!==JSON.stringify(native[i]))(cases[i].open?open:failures).push({i,actual:actual[i],expected:native[i]});
fs.writeFileSync('.cache/walking/comparison.json',JSON.stringify({cases:cases.length,failures,open},null,2));console.log(JSON.stringify({cases:cases.length,failures:failures.length,openCases:cases.filter(c=>c.open).length,openMismatches:open.length,first:failures.slice(0,2)},null,2));process.exitCode=failures.length?1:0;

}
