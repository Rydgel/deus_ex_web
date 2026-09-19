/** Compare the recovered AActor::Tick animation phases against original x86. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {parsePackage} from '../src/unreal/package.mjs';
import {decodeLodMesh} from '../src/runtime/lodmesh.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(), bytes=await readFile(`${root}/System/DeusExCharacters.u`);
const mesh=decodeLodMesh(parsePackage(bytes),bytes,669),cases=[];
const base={AnimSequence:'Walk',AnimFrame:0.1,AnimRate:0.5,TweenRate:2,
  AnimLast:0.875,AnimMinRate:0.2,OldAnimRate:0.5,animFlags:0x80000001,
  simAnim:{frame:1,rate:2,tween:3,last:4}};
const add=(name,seconds,actor={},extra={})=>cases.push({name,seconds,
  actor:{...base,...actor},sequences:mesh.sequences,...extra});
add('main-progress',0.2);
add('sequence-none',0.2,{AnimSequence:'None'});
add('stopped',0.2,{AnimRate:0});
add('zero-delta',0);
add('negative-delta',-1);
add('unordered-delta','NaN');
add('unfinished-tween',0.1,{AnimFrame:-0.5});
add('tween-remainder',0.4,{AnimFrame:-0.5});
add('tween-only-finished',0.4,{AnimFrame:-0.5,AnimRate:0});
add('tween-only-simulated-pawn',0.4,{AnimFrame:-0.5,AnimRate:0},{simulatedPawn:true});
add('one-shot-finished',0.5,{AnimFrame:0.8,latentAction:0x181});
add('one-shot-simulated-pawn',0.5,{AnimFrame:0.8},{simulatedPawn:true});
add('one-shot-remote-role',0.5,{AnimFrame:0.8,RemoteRole:2});
add('one-shot-weapon',0.5,{AnimFrame:0.8,isWeapon:true});
add('loop-threshold',0.1,{AnimFrame:0.85,animFlags:0x80000011,latentAction:0x181});
add('loop-wrap-after-threshold',0.3,{AnimFrame:0.95,animFlags:0x80000011});
add('loop-wrap-crosses-threshold',0.5,{AnimFrame:0.8,animFlags:0x80000011});
add('loop-iteration-budget',10,{animFlags:0x80000011,AnimRate:2});
add('velocity-scaled',0.013,{AnimRate:-3.1,Velocity:[1.1,2.2,3.3]});
add('velocity-minimum',0.2,{AnimRate:-0.1,Velocity:[0,0,1]});
add('notify-original-walk',0.45,{AnimFrame:0,AnimRate:1,animFlags:0x21});
const notifies=[{time:0.4,name:'Second'},{time:0.2,name:'First'},
  {time:0.2,name:'Tied'},{time:0.05,name:'Before'}];
const synthetic=[{name:'Walk',numFrames:8,rate:4,notifies}];
add('notify-order-and-tie',0.4,{AnimRate:1,animFlags:0x21},{sequences:synthetic});
add('notify-missing-function',0.4,{AnimRate:1,animFlags:0x21},
  {sequences:synthetic,missingFunctions:['First']});
add('notify-disabled',0.4,{AnimRate:1},{sequences:synthetic});
add('notify-null-mesh',0.4,{AnimRate:1,animFlags:0x21},{sequences:synthetic,noMesh:true});
add('notify-missing-sequence',0.4,{AnimRate:1,animFlags:0x21},{sequences:[]});
add('notify-simulated-pawn',0.4,{AnimRate:1,animFlags:0x21},{sequences:synthetic,simulatedPawn:true});
add('notify-callback-tween',0.4,{AnimRate:1,animFlags:0x21},{sequences:synthetic,
  callbacks:[{event:'First',actor:{AnimSequence:'Other',AnimFrame:-0.1,AnimRate:0,TweenRate:2,animFlags:1}}]});
add('end-callback-restart-replication-clamp',0.5,{AnimFrame:0.8},{
  callbacks:[{event:'AnimEnd',actor:{AnimSequence:'Other',AnimFrame:-1,AnimRate:10,TweenRate:0,animFlags:1}}]});
const blend={AnimSequence:'Walk',AnimFrame:0.1,AnimRate:0.5,TweenRate:2,AnimLast:0.875,
  AnimMinRate:0.2,OldAnimRate:1,simAnim:{frame:1,rate:2,tween:3,last:4}};
add('blend-repeated-passes',0.2,{blends:[blend]});
add('blend-main-stopped',0.2,{AnimRate:0,blends:[blend]});
add('blend-main-consumed-time',0.1,{AnimFrame:0.85,animFlags:0x11,blends:[blend]});
add('blend-finish-and-shared-remainder',0.4,{blends:[{...blend,AnimFrame:0.8},blend]});
add('blend-tween-shares-remainder',0.4,{blends:[{...blend,AnimFrame:-0.5},blend]});
add('blend-velocity-scaled',0.013,{Velocity:[1.1,2.2,3.3],blends:[{...blend,AnimRate:-3.1}]});
add('blend-velocity-minimum',0.2,{Velocity:[0,0,1],blends:[{...blend,AnimRate:-0.1}]});
add('blend-replication-gates',0.4,{RemoteRole:2,blends:[{...blend,AnimFrame:0.8}]});
add('blend-weapon-gate',0.4,{isWeapon:true,blends:[{...blend,AnimFrame:0.8}]});
// Synthetic records enter the same float32 storage as serialized mesh records.
for(const sample of cases)sample.sequences=sample.sequences.map(sequence=>({...sequence,
  notifies:sequence.notifies?.map(notify=>({...notify,time:Math.fround(Number(notify.time))}))}));
const reference=JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-animation-tick-oracle.py',root],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:8*1024*1024}));
if(process.argv.includes('--reference-only')) {
  await writeFile('.cache/research/animation-tick-original.json',JSON.stringify({cases,reference}));
  for(const value of reference.cases) {
    const after=Buffer.from(value.after,'hex');
    console.log(value.name,JSON.stringify({frame:after.readFloatLE(0x58),blend0:after.readFloatLE(0x78),
      blend1:after.readFloatLE(0x7c),iterations:value.iterations,
      events:value.events.filter(e=>e.op==='ProcessEvent').map(e=>e.name)}));
  }
  process.exit(0);
}

const {tickActorAnimation}=await import('../src/runtime/animation-tick.mjs');
const offsets={AnimFrame:0x58,AnimRate:0x5c,TweenRate:0x60,AnimLast:0x220,AnimMinRate:0x224,OldAnimRate:0x228};
const blendOffsets={AnimFrame:0x78,AnimRate:0x88,TweenRate:0x98,AnimLast:0x23c,AnimMinRate:0x24c,OldAnimRate:0x25c};
const simKeys=['frame','rate','tween','last'];
const bits=value=>{const b=Buffer.alloc(4);b.writeFloatLE(value);return b.readUInt32LE();};
for(let i=0;i<cases.length;i++) {
  const sample=cases[i],original=reference.cases[i],before=Buffer.from(original.before,'hex');
  const after=Buffer.from(original.after,'hex'),sim=at=>Object.fromEntries(simKeys.map((key,n)=>[key,before.readFloatLE(at+n*4)]));
  const actor={AnimSequence:original.names[before.readUInt32LE(0x54)],animFlags:before.readUInt32LE(0x28),
    RemoteRole:before[0x32],isWeapon:Boolean(sample.actor.isWeapon),latentAction:sample.actor.latentAction??0,
    Velocity:[0x144,0x148,0x14c].map(at=>before.readFloatLE(at)),simAnim:sim(0x22c),
    ...Object.fromEntries(Object.entries(offsets).map(([key,at])=>[key,before.readFloatLE(at)])),
    blends:Array.from({length:4},(_,n)=>({AnimSequence:original.names[before.readUInt32LE(0x68+n*4)],
      ...Object.fromEntries(Object.entries(blendOffsets).map(([key,at])=>[key,before.readFloatLE(at+n*4)])),simAnim:sim(0x26c+n*16)}))};
  const events=[];let callbackIndex=0;
  const result=tickActorAnimation(actor,Math.fround(Number(sample.seconds)),{
    mesh:()=>sample.noMesh?null:{sequences:sample.sequences},simulatedPawn:Boolean(sample.simulatedPawn),
    findFunction:(name,checked)=>{
      const found=checked||!sample.missingFunctions?.some(n=>n.toLowerCase()===name.toLowerCase());
      events.push({op:checked?'FindFunctionChecked':'FindFunction',name,found});return found?name:null;
    },
    processEvent:name=>{
      events.push({op:'ProcessEvent',name,frameBits:bits(actor.AnimFrame),rateBits:bits(actor.AnimRate),animFlags:actor.animFlags>>>0});
      const callback=sample.callbacks?.[callbackIndex];
      if(callback?.event.toLowerCase()===name.toLowerCase()) {
        for(const [key,value] of Object.entries(callback.actor))
          actor[key]=Object.hasOwn(offsets,key)?Math.fround(Number(value)):value;
        callbackIndex++;
      }
    },
  });
  const expected=Buffer.from(before);
  expected.writeUInt32LE(actor.animFlags>>>0,0x28);expected[0x32]=actor.RemoteRole;
  expected.writeUInt32LE(original.names.findIndex(n=>n.toLowerCase()===actor.AnimSequence.toLowerCase()),0x54);
  for(const [key,at] of Object.entries(offsets))expected.writeFloatLE(actor[key],at);
  for(const [n,key] of simKeys.entries())expected.writeFloatLE(actor.simAnim[key],0x22c+n*4);
  for(const [n,blend] of actor.blends.entries()) {
    expected.writeUInt32LE(original.names.findIndex(name=>name.toLowerCase()===blend.AnimSequence.toLowerCase()),0x68+n*4);
    for(const [key,at] of Object.entries(blendOffsets))expected.writeFloatLE(blend[key],at+n*4);
    for(const [j,key] of simKeys.entries())expected.writeFloatLE(blend.simAnim[key],0x26c+n*16+j*4);
  }
  const changed=[];
  for(let at=0;at<expected.length;at+=4)if(expected.readUInt32LE(at)!==after.readUInt32LE(at))
    changed.push({offset:at.toString(16),actual:expected.readFloatLE(at),native:after.readFloatLE(at)});
  assert.deepEqual(changed,[],sample.name);
  assert.deepEqual(events,original.events.filter(e=>['FindFunction','FindFunctionChecked','ProcessEvent'].includes(e.op)),sample.name);
  assert.equal(callbackIndex,original.callbacks,sample.name);
  assert.equal(actor.latentAction,original.latentAction,sample.name);
  const remaining=Buffer.alloc(4);remaining.writeUInt32LE(original.remainingBits);
  assert.equal(result.remainingSeconds,remaining.readFloatLE(),sample.name);
  assert.equal(result.iterations,original.iterations,sample.name);
}
console.log(`PASS ${cases.length} original animation tick cases: main/blend storage, remainder, event order, callback mutations and iteration budget.`);
