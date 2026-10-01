/** AActor::physPathing (src/runtime/pathing.mjs) against the original body
 * executed by scripts/native-pathing-oracle.py over controlled
 * InterpolationPoint paths (docs/pathing.md). Cases: linear and cubic
 * segments, forward and reverse crossings with their InterpolateEnd events,
 * bSkipNextPath runs, RateModifier/GameSpeedModifier/FovModifier and screen
 * flash blends on PlayerPawn, Pawn and plain actors, blocked moves, script
 * effects at the events, the original null-dereference faults, and a seeded
 * random sweep. Floats compare as float32 bit patterns.
 *
 *   node scripts/validate-native-pathing.mjs [--reuse]
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {physPathing} from '../src/runtime/pathing.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/pathing';await mkdir(directory,{recursive:true});
const f=Math.fround;
const view=new DataView(new ArrayBuffer(4));
const bits=v=>(view.setFloat32(0,v,true),view.getUint32(0,true));

// A closed loop of n points with distinct poses, Prev/Next links.
const loop=(n,make)=>Array.from({length:n},(_,i)=>({...make(i),prev:(i+n-1)%n,next:(i+1)%n}));
const square=loop(4,i=>({location:[[0,0,0],[256,0,32],[256,256,64],[0,256,16]][i],rotation:[0,i*16384,0]}));
const open=[{location:[0,0,0],rotation:[0,0,0],prev:null,next:1},{location:[100,50,-20],rotation:[2000,8000,-300],prev:0,next:null}];
const cases=[];
const base={actorClass:'actor',location:[0,0,0],rotation:[0,0,0]};
for(const alpha of [0,.25,.5,.99])for(const dt of [1/60,.1,.5])cases.push({...base,points:square,target:1,alpha,rate:1,dt});
for(const alpha of [0,.5])for(const dt of [1/60,.3])cases.push({...base,points:open,target:0,alpha,rate:1,dt,effects:{0:{interpolating:false}}});
// Reverse travel and crossings.
for(const alpha of [.5,.01,0])for(const dt of [1/60,.25,1.5])cases.push({...base,points:square,target:2,alpha,rate:-.75,dt});
// Long dt crossing several segments, with and without skips.
cases.push({...base,points:square,target:0,alpha:.5,rate:2,dt:2.3});
cases.push({...base,points:square.map((p,i)=>({...p,skip:i===2})),target:0,alpha:.9,rate:1,dt:.4});
cases.push({...base,points:square.map((p,i)=>({...p,skip:i===0})),target:2,alpha:.1,rate:-1,dt:.4});
// Modifiers and screen flash on each actor class.
const styled=square.map((p,i)=>({...p,rateModifier:[1,.5,2,1.25][i],gameSpeed:[1,.25,.5,2][i],fov:[1,.8,1.3,.6][i],
  flashScale:[1,.3,.7,0][i],flashFog:[[0,0,0],[.5,.25,0],[1,0,.75],[.1,.2,.3]][i]}));
for(const actorClass of ['playerpawn','pawn','actor'])for(const alpha of [0,.3,.95])
  cases.push({...base,actorClass,points:styled,target:1,alpha,rate:.8,dt:.2,defaultFov:90,fov:75});
// Blocked moves, effects that stop or reverse at an event.
cases.push({...base,points:square,target:1,alpha:.9,rate:1,dt:.5,blocked:[0,1]});
cases.push({...base,points:square,target:1,alpha:.9,rate:1,dt:.5,effects:{1:{interpolating:false}}});
cases.push({...base,points:square,target:1,alpha:.9,rate:1,dt:.5,effects:{0:{rate:-1}}});
cases.push({...base,points:square,target:1,alpha:.9,rate:0,dt:.5});
cases.push({...base,points:square,target:1,alpha:.5,rate:1,dt:0});
cases.push({...base,points:square,target:1,alpha:.5,rate:1,dt:.1,interpolating:false});
// Rotator wrap and large weights.
cases.push({...base,points:loop(4,i=>({location:[i*1e5,-i*3e4,i],rotation:[0x7fff0000*(i&1),-0x7fffffff+i*999,(i*0x40000000)|0]})),target:1,alpha:.4,rate:1,dt:.3});
// The original faults: a non-InterpolationPoint Target and a missing Next.
cases.push({...base,points:[{location:[0,0,0],ip:false,prev:null,next:null}],target:0,alpha:0,rate:1,dt:.1});
cases.push({...base,points:[{location:[0,0,0],prev:null,next:null}],target:0,alpha:0,rate:1,dt:.1});
// Seeded random sweep.
let seed=0x2468ace1;
const random=()=>(seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32;
const pick=list=>list[Math.floor(random()*list.length)];
const coord=()=>f((random()-.5)*pick([16,512,8192]));
const angle=()=>pick([()=>Math.floor((random()-.5)*131072),()=>Math.floor((random()-.5)*2**32)|0])();
for(let i=0;i<250;i++){
  const n=pick([3,4,5,8]);
  const points=loop(n,()=>({location:[coord(),coord(),coord()],rotation:[angle(),angle(),angle()],
    rateModifier:f(pick([1,1,random()*2])),gameSpeed:f(pick([1,random()*2])),fov:f(pick([1,random()*2])),
    flashScale:f(random()),flashFog:[f(random()),f(random()),f(random())],skip:random()<.15}));
  if(random()<.2)points[0].prev=null;
  cases.push({actorClass:pick(['playerpawn','pawn','actor']),location:[coord(),coord(),coord()],rotation:[angle(),angle(),angle()],
    points,target:Math.floor(random()*n),alpha:f(pick([0,1,random(),random()*1.2-.1])),rate:f(pick([1,-1,random()*4-2,.25])),
    dt:f(pick([1/60,1/30,random(),random()*3])),defaultFov:f(pick([90,75,random()*120])),fov:f(90),
    blocked:random()<.2?[0,2]:[],effects:random()<.3?{[Math.floor(random()*3)]:pick([{interpolating:false},{rate:f(random()*2-1)}])}:{}});
}
await writeFile(`${directory}/cases.json`,JSON.stringify(cases));
if(!process.argv.includes('--reuse')){
  const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-pathing-oracle.py',gameDirectory(),`${directory}/cases.json`],{encoding:'utf8',maxBuffer:1<<27});
  if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/original.json`,native.stdout);
}
const reference=JSON.parse(await readFile(`${directory}/original.json`,'utf8'));
assert.equal(reference.results.length,cases.length,'the capture matches the case list (rerun without --reuse)');

function run(c){
  const ZERO3=[0,0,0];
  const actor={cls:c.actorClass??'actor',PhysRate:f(c.rate),PhysAlpha:f(c.alpha),bInterpolating:c.interpolating??true,
    Location:c.location.map(f),Rotation:(c.rotation??ZERO3).map(v=>v|0),FovAngle:f(c.fov??90),ViewRotation:[0,0,0],
    FlashScale:[0,0,0],FlashFog:[0,0,0],DesiredFlashScale:0,DesiredFlashFog:[0,0,0]};
  const level={TimeDilation:0};actor.Level=level;
  const points=c.points.map(p=>({cls:p.ip===false?'other':'ip',Location:p.location.map(f),Rotation:(p.rotation??ZERO3).map(v=>v|0),
    RateModifier:f(p.rateModifier??1),GameSpeedModifier:f(p.gameSpeed??1),FovModifier:f(p.fov??1),bSkipNextPath:Boolean(p.skip),
    ScreenFlashScale:f(p.flashScale??1),ScreenFlashFog:(p.flashFog??ZERO3).map(f)}));
  c.points.forEach((p,i)=>{points[i].Prev=p.prev==null?null:points[p.prev];points[i].Next=p.next==null?null:points[p.next];});
  actor.Target=c.target==null?null:points[c.target];
  const name=o=>o===null?null:o===actor?'self':points.indexOf(o);
  const events=[],blocked=new Set(c.blocked??[]),effects=c.effects??{};let moves=0,calls=0;
  const ancestry={playerpawn:['engine.playerpawn','engine.pawn'],pawn:['engine.pawn'],actor:[],ip:['engine.interpolationpoint'],other:[]};
  try{
    physPathing(actor,c.dt,{
      read:(o,k)=>o[k],write:(o,k,v)=>{o[k]=v;},
      isA:(o,key)=>ancestry[o.cls].includes(key),
      defaultFovAngle:()=>f(c.defaultFov??90),
      moveActor:(a,delta,rotation)=>{
        const block=blocked.has(moves++);
        events.push({move:delta.map(bits),rotation:[...rotation],applied:!block});
        if(!block){a.Location=a.Location.map((v,i)=>f(v+delta[i]));a.Rotation=[...rotation];}
      },
      interpolateEnd:(receiver,other)=>{
        events.push({interpolateEnd:name(receiver),other:name(other)});
        const effect=effects[String(calls++)];
        if(effect){if('interpolating' in effect)actor.bInterpolating=effect.interpolating;if('rate' in effect)actor.PhysRate=f(effect.rate);}
      },
    });
  }catch(error){if(/physPathing:/.test(error.message))return {fault:error.message};throw error;}
  const playerPawn=actor.cls==='playerpawn';
  return {events,location:actor.Location.map(bits),rotation:actor.Rotation,alpha:bits(actor.PhysAlpha),rate:bits(actor.PhysRate),
    interpolating:actor.bInterpolating,target:name(actor.Target),timeDilation:bits(level.TimeDilation),
    fov:bits(actor.FovAngle),viewRotation:actor.ViewRotation,
    flashScale:actor.FlashScale.map(bits),flashFog:actor.FlashFog.map(bits),
    desiredFlashScale:bits(actor.DesiredFlashScale),desiredFlashFog:actor.DesiredFlashFog.map(bits),playerPawn};
}
let mismatches=0,moves=0,ends=0,faults=0,cubic=0;
for(const [index,c] of cases.entries()){
  const expected=reference.results[index],actual=run(c);
  if(expected.fault||actual.fault){
    faults++;
    if(!(expected.fault&&actual.fault)){mismatches++;if(mismatches<=5)console.log(JSON.stringify({index,actual,expected}).slice(0,1500));}
    continue;
  }
  delete actual.playerPawn;
  moves+=actual.events.filter(e=>e.move).length;ends+=actual.events.filter(e=>'interpolateEnd' in e).length;
  if(JSON.stringify(actual)!==JSON.stringify(expected)){mismatches++;if(mismatches<=5)console.log(JSON.stringify({index,actual,expected}).slice(0,3000));}
}
console.log(JSON.stringify({cases:cases.length,moves,interpolateEnds:ends,faults,mismatches}));
if(mismatches)process.exitCode=1;
