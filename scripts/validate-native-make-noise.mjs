import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {execMakeNoise} from '../src/runtime/script-noise.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {gameDirectory} from './game-directory.mjs';
const directory='.cache/actor-queries';await mkdir(directory,{recursive:true});
// Mirrors native-make-noise-oracle.py: chain = symbolic class ancestry (first
// entry is the object's Class, each links +0x28 to the next); slot seeds are
// the instigator's noise1*/noise2* fields; `probing` overrides IsProbing per
// pawn; `linecheck` is the FastLineCheck return; `levelInfo:'no'` gives
// Actors[0] a non-LevelInfo class (warns 0xf2 and continues, like the original).
const cases=[
 {id:'dispatch',loudness:1.0,time:100.0,location:[0,0,0],emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
 {id:'suppress-slot1',loudness:1.0,time:100.0,emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:99.9,loud:2.0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
 {id:'suppress-slot2',loudness:1.0,time:100.0,emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:0,loud:0},slot2:{time:99.95,loud:1.5}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
 {id:'suppress-fresh-boundary',loudness:1.0,time:100.0,emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:99.8,loud:2.0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
 {id:'suppress-near-boundary',loudness:1.0,time:100.0,location:[0,0,0],emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:99.9,loud:2.0,spot:[50,0,0]},slot2:{time:0,loud:0}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
 {id:'suppress-loud-boundary',loudness:1.0,time:100.0,emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:99.9,loud:0.9},slot2:{time:0,loud:0}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
 {id:'write-slot2-stale',loudness:1.5,time:100.0,location:[1,2,3],emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:99.9,loud:0.1},slot2:{time:50,loud:0}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
 {id:'write-both-fresh-near',loudness:2.0,time:100.0,emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:99.9,loud:1.0},slot2:{time:99.95,loud:0.5}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
 {id:'write-both-fresh-far',loudness:2.0,time:100.0,emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:99.9,loud:1.0,spot:[100,0,0]},slot2:{time:99.95,loud:0.5}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
 {id:'write-both-fresh-loud',loudness:1.0,time:100.0,emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:99.9,loud:2.0,spot:[500,0,0]},slot2:{time:99.95,loud:2.0,spot:[500,0,0]}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
 {id:'skip-instigator',loudness:1.0,time:100.0,emitterChain:['Emitter'],instigatorInList:true,
  instigator:{chain:['Emitter'],bIsPlayer:true,pri:{team:1},slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[]},
 {id:'probing-off',loudness:1.0,time:100.0,emitterChain:['Emitter'],probing:{pawn0:false},
  instigator:{chain:['Pawn'],slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
 {id:'class-unrelated',loudness:1.0,time:100.0,emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Other'],location:[10,0,0],threshold:0.5}]},
 {id:'class-super',loudness:1.0,time:100.0,emitterChain:['Sub','Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Emitter'],location:[10,0,0],threshold:0.5}]},
 {id:'alt-playerpawn',loudness:1.0,time:100.0,
  instigator:{chain:['Pawn'],bIsPlayer:true,slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['SubPP','PlayerPawn'],location:[10,0,0],threshold:0.5},
   {chain:['Emitter'],location:[10,0,0],threshold:0.5}]},
 {id:'alt-enemy',loudness:1.0,time:100.0,
  instigator:{chain:['Pawn'],enemy:{chain:['Pawn'],bIsPlayer:true},slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['PlayerPawn'],location:[10,0,0],threshold:0.5},
   {chain:['Emitter'],location:[10,0,0],threshold:0.5}]},
 {id:'hear-range-fail',loudness:1.0,time:100.0,emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Emitter','Pawn'],location:[3000,0,0],threshold:0.5}]},
 {id:'hear-zero-dist',loudness:1.0,time:100.0,location:[5,5,5],emitterChain:['Emitter'],linecheck:0,
  instigator:{chain:['Pawn'],slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Emitter','Pawn'],location:[5,5,5],threshold:100}]},
 {id:'hear-threshold-fail',loudness:1.0,time:100.0,emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:5.0}]},
 {id:'hear-line-fail',loudness:1.0,time:100.0,emitterChain:['Emitter'],linecheck:0,
  instigator:{chain:['Pawn'],slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
 {id:'hear-alertness',loudness:1.0,time:100.0,emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:2.4,alertness:1.0}]},
 {id:'team-wide-range',loudness:1.0,time:100.0,gameFlags:512,
  instigator:{chain:['Pawn'],bIsPlayer:true,pri:{team:2},slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Pawn'],bIsPlayer:true,pri:{team:2},location:[3000,0,0],threshold:0.5}]},
 {id:'team-diff-team',loudness:1.0,time:100.0,gameFlags:512,
  instigator:{chain:['Pawn'],bIsPlayer:true,pri:{team:2},slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Pawn'],bIsPlayer:true,pri:{team:3},location:[3000,0,0],threshold:0.5}]},
 {id:'team-no-pri',loudness:1.0,time:100.0,gameFlags:512,
  instigator:{chain:['Pawn'],bIsPlayer:true,pri:{team:2},slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Pawn'],bIsPlayer:true,location:[3000,0,0],threshold:0.5}]},
 {id:'team-nonteam-game',loudness:1.0,time:100.0,gameFlags:0,
  instigator:{chain:['Pawn'],bIsPlayer:true,pri:{team:2},slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Pawn'],bIsPlayer:true,pri:{team:2},location:[3000,0,0],threshold:0.5}]},
 {id:'netmode-client',loudness:1.0,time:100.0,netmode:3,emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
 {id:'no-instigator',loudness:1.0,time:100.0,emitterChain:['Emitter'],instigator:null,
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
 // actors-null: the original warns 0xf1/0xf2 on both paths, runs the slot
 // writes, then reads a wild PawnList pointer off the null actor — emulation
 // returns a zero page there, so the oracle finishes cleanly while the port
 // raises its explicit field-read error at the same deref. Warns and the
 // completed slot writes are the faithful shared surface.
 {id:'actors-null',loudness:1.0,time:100.0,actorsNull:true,emitterChain:['Emitter'],compare:'warns+slots',
  instigator:{chain:['Pawn'],slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
 {id:'levelinfo-wrong',loudness:1.0,time:100.0,levelInfo:'no',emitterChain:['Emitter'],
  instigator:{chain:['Pawn'],slot1:{time:0,loud:0},slot2:{time:0,loud:0}},
  pawns:[{chain:['Emitter','Pawn'],location:[10,0,0],threshold:0.5}]},
];
await writeFile(`${directory}/make-noise-cases.json`,JSON.stringify(cases.map(({compare,...c})=>c)));
if(!process.argv.includes('--reuse')){
 const native=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-make-noise-oracle.py',gameDirectory(),`${directory}/make-noise-cases.json`],{encoding:'utf8'});
 if(native.status!==0)throw Error(native.stderr);await writeFile(`${directory}/make-noise.json`,native.stdout);
}
const reference=JSON.parse(await readFile(`${directory}/make-noise.json`,'utf8'));let mismatches=0;
// Fabricate the same graph the oracle maps into native memory. Class names
// share record objects so the bidirectional ancestry test sees the same
// identities; `LevelInfo`/`PlayerPawn` are just names on the JS side.
const RECORDS={};
const record=name=>RECORDS[name]??={key:`engine.${name.toLowerCase()}`,name};
const chain=names=>{let head=null;for(let i=names.length-1;i>=0;i--)head={record:record(names[i]),base:head};return head;};
for(const [index,c] of cases.entries()){
 const expected=reference.results[index];
 const F=Math.fround,vec=a=>a.map(F);
 const setup=()=>{
  const game={id:'game',fields:{bTeamGame:(c.gameFlags??0)&0x200}};
  const levelInfo={id:'levelinfo',cls:c.levelInfo==='no'?chain(['Other']):chain(['LevelInfo']),
   fields:{Game:game}};
  const level={actors:[c.actorsNull?null:levelInfo],netMode:c.netmode??0,
   timeSeconds:F(c.time??100.0),model:{id:'model'}};
  const pawns=[];
  const makePawn=(key,cfg)=>{
   const p={id:key,cls:chain(cfg.chain??['Pawn']),nextPawn:null,fields:{
    Location:vec(cfg.location??[0,0,0]),
    bIsPlayer:cfg.bIsPlayer?2:0,
    Alertness:F(cfg.alertness??0),Stimulus:F(cfg.stimulus??0),HearingThreshold:F(cfg.threshold??0),
    PlayerReplicationInfo:null,Enemy:null}};
   if(cfg.pri!=null)p.fields.PlayerReplicationInfo={id:`${key}:pri`,fields:{Team:cfg.pri.team??0,Stimulus:0}};
   return p;};
  const ins=c.instigator==null?null:{id:'instigator',cls:chain(c.instigator.chain??['Pawn']),nextPawn:null,fields:{
   Location:vec(c.instigator.location??[0,0,0]),bIsPlayer:c.instigator.bIsPlayer?2:0,
   Enemy:c.instigator.enemy?makePawn('enemy',c.instigator.enemy):null,
   PlayerReplicationInfo:null,
   noise1spot:vec(c.instigator.slot1?.spot??[0,0,0]),noise1time:F(c.instigator.slot1?.time??0),
   noise1other:c.instigator.slot1?.other??0,noise1loudness:F(c.instigator.slot1?.loud??0),
   noise2spot:vec(c.instigator.slot2?.spot??[0,0,0]),noise2time:F(c.instigator.slot2?.time??0),
   noise2other:c.instigator.slot2?.other??0,noise2loudness:F(c.instigator.slot2?.loud??0)}};
  if(ins&&c.instigator.pri!=null)ins.fields.PlayerReplicationInfo={id:'instigator:pri',fields:{Team:c.instigator.pri.team??0}};
  const emitter={id:'emitter',cls:chain(c.emitterChain??['Emitter']),
   fields:{Instigator:ins,Location:vec(c.location??[0,0,0])}};
  let prev=null;
  for(const [i,cfg] of (c.pawns??[]).entries()){
   const p=makePawn(`pawn${i}`,cfg);pawns.push(p);
   if(prev)prev.nextPawn=p;else level.pawnList=p;prev=p;
  }
  if(!prev)level.pawnList=null;
  if(c.instigatorInList&&ins){
   if(prev)prev.nextPawn=ins;else level.pawnList=ins;
  }
  const collect=()=>{
   const stimulus={};
   for(const p of pawns){stimulus[p.id]=p.fields.Stimulus;
    if(p.fields.PlayerReplicationInfo)stimulus[`${p.id}:pri`]=p.fields.PlayerReplicationInfo.fields.Stimulus;}
   const slots={};
   if(ins){for(const n of [1,2])slots[`slot${n}`]={spot:ins.fields[`noise${n}spot`],
    time:ins.fields[`noise${n}time`],other:ins.fields[`noise${n}other`],loud:ins.fields[`noise${n}loudness`]};}
   return {stimulus,slots};
  };
  // The recorded service calls shared by both passes.
  const warns=[],probes=[],events=[],lines=[];
  const runtime=Object.create(ScriptRuntime.prototype);
  runtime.boundaryNatives=new Set();runtime.collisionViewActors=new WeakSet();
  runtime.instances=new WeakMap();
  const attach=o=>{if(o&&!runtime.instances.has(o))runtime.instances.set(o,{cls:o.cls??null});};
  for(const o of [emitter,ins,levelInfo,...pawns,ins?.fields.Enemy])attach(o);
  runtime.levelFor=()=>level;
  runtime.namedReference=(actor,name)=>({get:()=>actor.fields?.[name],set:v=>{actor.fields[name]=v;}});
  runtime.readNamed=(actor,name)=>runtime.namedReference(actor,name).get();
  runtime.writeNamed=(actor,name,value)=>runtime.namedReference(actor,name).set(value);
  runtime.warning=msg=>warns.push(msg.kind);
  runtime.isProbing=(actor,name)=>{probes.push(actor.id);return c.probing?.[actor.id]!==false;};
  runtime.processNativeEvent=(receiver,name,args)=>events.push({pawn:receiver.id,fn:name,
   loudness:args[0],source:args[1].id});
  const bound=runtime.noiseServices.bind(runtime);
  runtime.noiseServices=call=>{const s=bound(call);s.fastLineCheck=(model,start,end)=>{
   if(!model)throw new Error('Original sound requires the live level model');
   lines.push({start,end});return c.linecheck??1;};return s;};
  return {runtime,warns,probes,events,lines,emitter,collect};
 };
 // Helper level: execMakeNoise through the same services the binding builds.
 const helper=setup();
 let helperFault=null;
 try{execMakeNoise({receiver:helper.emitter,argumentCount:1,evaluateArgument:i=>c.loudness},
  helper.runtime.noiseServices({receiver:helper.emitter}));}catch(e){helperFault=String(e);}
 const helperActual={warns:helper.warns,probes:helper.probes,events:helper.events,
  lines:helper.lines,...helper.collect(),fault:helperFault!==null};
 // Binding level: invokeNative(512) through the real dispatch.
 const bound=setup();
 let boundFault=null;
 try{bound.runtime.invokeNative({index:512,argumentCount:1,receiver:bound.emitter,
  evaluateArgument:i=>c.loudness});}catch(e){boundFault=String(e);}
 const boundActual={warns:bound.warns,probes:bound.probes,events:bound.events,
  lines:bound.lines,...bound.collect(),fault:boundFault!==null};
 const comparable=r=>c.compare==='warns+slots'?{warns:r.warns,slots:r.slots}:
  {warns:r.warns,probes:r.probes,events:r.events,
  lines:r.lines,slots:r.slots,stimulus:r.stimulus,fault:Boolean(r.fault)};
 const expectedComp=comparable({...expected,fault:expected.fault!==null&&expected.fault!==undefined});
 try{assert.deepEqual(comparable(helperActual),expectedComp);}catch(e){mismatches++;console.log(JSON.stringify({index,id:c.id,helper:comparable(helperActual),expected:expectedComp}));}
 try{assert.deepEqual(comparable(boundActual),expectedComp);}catch(e){mismatches++;console.log(JSON.stringify({index,id:c.id,bound:comparable(boundActual),expected:expectedComp}));}
}
console.log(JSON.stringify({cases:cases.length,mismatches}));if(mismatches)process.exitCode=1;
