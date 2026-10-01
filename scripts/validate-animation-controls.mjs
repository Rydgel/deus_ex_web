/** Full original exec comparisons; bounded coverage of the recovered branches. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {parsePackage} from '../src/unreal/package.mjs';
import {decodeLodMesh} from '../src/runtime/lodmesh.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(), bytes=await readFile(`${root}/System/DeusExCharacters.u`);
const pkg=parsePackage(bytes), mesh=decodeLodMesh(pkg,bytes,669), cases=[];
const seq=name=>mesh.sequences.find(s=>s.name===name);
const add=(native,name,args,actor={},extra={})=>cases.push({native,name,args,actor,
  sequences:mesh.sequences,...extra});
const previous={AnimSequence:'Still',animFlags:0x800000ff,AnimMinRate:0.37,
  simAnim:{frame:1,rate:2,tween:3,last:4}};
add('PlayAnim','fresh-optional-hole',['HitTorso',null,0.1]);
add('PlayAnim','positive-multi-tween',['HitTorso',1,0.125],previous);
add('PlayAnim','positive-single-tween',['Still',1,0.5],previous);
add('PlayAnim','single-default-tween',['Still'],previous);
add('PlayAnim','auto-zero-old-rate',['Walk'],previous);
add('PlayAnim','auto-positive-old-rate',['Walk'],{...previous,OldAnimRate:3.5});
add('PlayAnim','auto-velocity-old-rate',['Walk'],{...previous,OldAnimRate:-3.1,Velocity:[1.1,2.2,3.3]});
add('PlayAnim','auto-velocity-half-rate-clamp',['Walk'],{...previous,OldAnimRate:-0.1,Velocity:[0,0,1]});
add('PlayAnim','immediate-negative-rate',['Walk',-2,0],previous);
add('PlayAnim','immediate-negative-time',['HitTorso',1,-2],previous);
add('PlayAnim','sim-identical',['HitTorso',1,0],{...previous,
  simAnim:{frame:10,rate:12500,tween:0,last:7500}});
add('PlayAnim','sim-all-differ',['HitTorso',1,0],previous);
add('PlayAnim','sim-unordered',['HitTorso',1,0],{...previous,
  simAnim:{frame:'NaN',rate:2,tween:3,last:4}});
add('PlayAnim','rate-upper-clamp',['Walk',1000,0],previous);
add('PlayAnim','unordered-tween',['Walk',1,'NaN'],previous);
add('LoopAnim','start-optional-hole',['Walk',null,0.1,0.2]);
add('LoopAnim','start-positive-tween',['Walk',-2,0.5,0.3],previous);
add('LoopAnim','start-auto-tween',['Walk'],previous);
add('LoopAnim','single-loop',['Still'],previous);
const looping={...previous,AnimSequence:'Walk',AnimFrame:0.4,AnimRate:1,TweenRate:3,
  AnimLast:0.9,animFlags:0x800000ff};
add('LoopAnim','continue-preserves-time',['wAlK',1,0.5,0.2],looping);
add('LoopAnim','continue-tween',['Walk',2,0.5],{...looping,AnimFrame:-0.1});
add('LoopAnim','stopped-restarts',['Walk',1,0],{...looping,AnimRate:0});
add('LoopAnim','stopped-tween-restarts',['Walk',1,0],{...looping,AnimFrame:-0.1,TweenRate:0});
add('LoopAnim','continue-rate-not-clamped',['Walk',1000],looping);
add('LoopAnim','start-rate-clamped',['Walk',1000],previous);
add('LoopAnim','continue-identical',['HitTorso',1],{...looping,AnimSequence:'HitTorso',
  simAnim:{frame:1,rate:12500,tween:3,last:-7500}});
add('LoopAnim','unordered-min-rate',['Walk',1,0,'NaN'],previous);
add('TweenAnim','positive-tween',['HitTorso',0.5],previous);
add('TweenAnim','instant-tween',['Walk',0],previous);
add('TweenAnim','negative-tween',['Walk',-1],previous);
add('TweenAnim','unordered-time',['Walk','NaN'],previous);
for(const native of ['PlayAnim','LoopAnim','TweenAnim']) {
  add(native,`${native}-null-mesh`,['Walk',0.5],previous,{noMesh:true});
  add(native,`${native}-missing-sequence`,['AbsentSequence',0.5],previous);
}
// IsAnimating (282): [AnimSequence, AnimFrame, AnimRate, TweenRate, expected].
// 'NaN' and '-0' survive JSON as strings; the oracle stores them as float32.
const animating=[
  ['none-sequence','None',0.3,1,1,0],['playing','Walk',0.3,0.5,0,1],['stopped','Walk',0.3,0,2,0],
  ['tween-in','Walk',-0.1,0.5,2.5,1],['tween-done','Walk',-0.1,0.5,0,0],['frame-zero-not-below','Walk',0,0,3,0],
  ['frame-negative-zero','Walk','-0',1,0,1],['frame-unordered-stopped','Walk','NaN',1,0,0],
  ['frame-unordered-tween','Walk','NaN',0,2,1],['rate-unordered','Walk',0.5,'NaN',0,0],
  ['tween-unordered','Walk',-0.5,1,'NaN',0],['rate-negative','Walk',0.2,-1,0,1],
  ['rate-negative-zero','Walk',0.2,'-0',5,0],['rate-denormal','Walk',0.2,1e-45,0,1],
  ['frame-negative-denormal','Walk',-1e-45,0,1,1],
];
for(const [name,AnimSequence,AnimFrame,AnimRate,TweenRate,expected] of animating)
  add('IsAnimating',name,[],{...previous,AnimSequence,AnimFrame,AnimRate,TweenRate},{expected});
assert.equal(seq('HitTorso').numFrames,4);
const reference=JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-animation-oracle.py',root],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:8*1024*1024}));
if(process.argv.includes('--reference-only')) {
  await writeFile('.cache/research/animation-controls-original.json',JSON.stringify({cases,reference}));
  console.log(`${reference.cases.length} original animation exec cases captured.`);
  process.exit(0);
}
const {execPlayAnim,execLoopAnim,execTweenAnim,isAnimating}=await import('../src/runtime/play-anim.mjs');
const controls={PlayAnim:execPlayAnim,LoopAnim:execLoopAnim,TweenAnim:execTweenAnim};
const offsets={AnimFrame:0x58,AnimRate:0x5c,TweenRate:0x60,AnimLast:0x220,AnimMinRate:0x224,OldAnimRate:0x228};
for(let i=0;i<cases.length;i++) {
  const sample=cases[i], original=reference.cases[i], before=Buffer.from(original.before,'hex');
  const after=Buffer.from(original.after,'hex'), actor={animFlags:before.readUInt32LE(0x28),
    AnimSequence:original.names[before.readUInt32LE(0x54)],
    Velocity:[0x144,0x148,0x14c].map(at=>before.readFloatLE(at)),
    simAnim:Object.fromEntries(['frame','rate','tween','last'].map((key,n)=>[key,before.readFloatLE(0x22c+n*4)])),
    ...Object.fromEntries(Object.entries(offsets).map(([key,at])=>[key,before.readFloatLE(at)]))};
  if(sample.native==='IsAnimating'){
    assert.equal(original.result,sample.expected,`${sample.name}: original verdict`);
    assert.equal(isAnimating(actor),original.result,sample.name);
    assert.equal(original.after,original.before,`${sample.name}: actor storage untouched`);
    assert.equal(original.codeAdvance,1,`${sample.name}: P_FINISH`);
    continue;
  }
  const logs=[], args=sample.args.slice(1).map(value=>value===null?undefined:Math.fround(Number(value)));
  const actualMesh=sample.noMesh?null:{...mesh,sequences:sample.sequences};
  if(sample.native==='TweenAnim')execTweenAnim(actor,actualMesh,sample.args[0],args[0],(...v)=>logs.push(v));
  else controls[sample.native](actor,actualMesh,sample.args[0],args[0]??1,args[1]??-1,
    ...(sample.native==='LoopAnim'?[args[2]??0]:[]),(...v)=>logs.push(v));
  const expected=Buffer.from(before);
  expected.writeUInt32LE(actor.animFlags>>>0,0x28);
  expected.writeUInt32LE(original.names.findIndex(name=>name.toLowerCase()===actor.AnimSequence.toLowerCase()),0x54);
  for(const [key,at] of Object.entries(offsets))expected.writeFloatLE(actor[key],at);
  for(const [n,key] of ['frame','rate','tween','last'].entries())expected.writeFloatLE(actor.simAnim[key],0x22c+n*4);
  // NaN payload/sign is not represented in the VM's JS-number cells.
  for(const at of [...Object.values(offsets),0x22c,0x230,0x234,0x238])
    if(Number.isNaN(expected.readFloatLE(at))&&Number.isNaN(after.readFloatLE(at)))after.copy(expected,at,at,at+4);
  const changed=[];
  for(let at=0;at<expected.length;at+=4)if(expected.readUInt32LE(at)!==after.readUInt32LE(at))
    changed.push({offset:at.toString(16),actual:expected.readFloatLE(at),native:after.readFloatLE(at)});
  assert.deepEqual(changed,[],sample.name);
  assert.equal(logs.length,original.events.filter(e=>e.op==='Warning').length,sample.name);
  const count=sample.native==='PlayAnim'?3:sample.native==='LoopAnim'?4:2;
  assert.equal(original.codeAdvance,count+1);
  assert.deepEqual(original.events.filter(e=>e.op==='Step').map(e=>e.index),Array.from({length:count},(_,n)=>n));
}
console.log(`PASS ${cases.length} original animation controls: complete actor storage, optional arguments, lookup/guards, reciprocal tweening, LoopAnim continuation and SimAnim writes; ${animating.length} IsAnimating verdicts including tweens, signed zeros, denormals and NaN.`);
