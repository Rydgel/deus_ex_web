/** Original complete Actor.Tick comparisons for standalone authority actors. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {gameDirectory} from './game-directory.mjs';

const cases=[],base={Role:4,RemoteRole:2,Physics:0,animFlags:1,LastRenderTime:0,
  DistanceFromPlayer:0,TimerRate:0,TimerCounter:0,LifeSpan:0,SightCounter:0.2};
const add=(name,actor={},extra={})=>cases.push({name,seconds:0.125,actor:{...base,
  ...(extra.kind&&extra.kind!=='Actor'?{animFlags:0x800001}:{}),...actor},...extra});
add('ordinary-tick');
add('tick-probe-disabled',{}, {disabledProbes:['Tick']});
add('animation-before-script',{AnimSequence:'HitTorso',AnimFrame:0.7,AnimRate:2.5,AnimLast:0.75});
add('tick-type-one-skips-script',{AnimSequence:'HitTorso',AnimFrame:0.1,AnimRate:2.5,AnimLast:0.75},{tickType:1});
add('owner-deferred',{}, {ownerTicked:false});
add('owner-deferred-allocation-fails',{}, {ownerTicked:false,allocationFails:true});
add('owner-already-ticked',{}, {ownerTicked:true});
add('tick-tag-zero-clears-bit',{animFlags:0x201},{tickTag:0});
add('stasis-old-zone',{animFlags:0x200001},{timeSeconds:6});
add('stasis-boundary-five-seconds',{animFlags:0x200001},{timeSeconds:5});
add('stasis-recent-zone-near',{animFlags:0x200001},{timeSeconds:6,zoneLastRenderTime:5});
add('stasis-recent-zone-far',{animFlags:0x200001,DistanceFromPlayer:1201},{timeSeconds:6,zoneLastRenderTime:5});
add('stasis-walking-admitted',{animFlags:0x200001,Physics:1},{timeSeconds:6});
add('stasis-force-walking',{animFlags:0x600001,Physics:1},{timeSeconds:6});
add('stasis-transient-destroy',{animFlags:0x200001,flags2:2},{timeSeconds:6});
add('timer-state-before-timer',{TimerRate:1,TimerCounter:0},{callbacks:[
  {event:'ProcessState',actor:{TimerRate:0.125,TimerCounter:0}}]});
add('timer-one-shot',{TimerRate:0.125,TimerCounter:0});
add('timer-loop-reentrant',{animFlags:0x1001,TimerRate:0.125,TimerCounter:0.1},{callbacks:[
  {event:'Timer',actor:{TimerRate:1,TimerCounter:0,LifeSpan:1}}]});
add('lifespan-before-physics',{LifeSpan:1,Physics:1});
add('expired-even-if-callback-extends',{LifeSpan:0.1,Physics:1},{callbacks:[
  {event:'Expired',actor:{LifeSpan:5}}]});
add('tick-callback-controls-physics',{Physics:0},{callbacks:[{event:'Tick',actor:{Physics:1}}]});
add('remote-autonomous-branch',{RemoteRole:3,Physics:1,LifeSpan:1,TimerRate:0.125});
add('remote-autonomous-view-target',{RemoteRole:3},{kind:'PlayerPawn',
  viewTarget:{ViewRotation:[101,202,303],EyeHeight:39.5,weaponOffset:[1.5,2.5,3.5]}});
add('pawn-ai-timers',{SightCounter:0.05,PainTime:0.125,SpeechTime:0.125,pawnFlags:0x80000000},{kind:'Pawn'});
add('pawn-hidden-player',{pawnFlags:2,animFlags:0x800003},{kind:'Pawn'});
add('pawn-visible-player',{pawnFlags:2},{kind:'Pawn'});
add('pawn-negative-sight-once',{SightCounter:-1},{kind:'Pawn',disabledProbes:['EnemyNotVisible']});
add('pawn-check-sight-reset-after-callback',{SightCounter:0.01},{kind:'Pawn',callbacks:[
  {event:'CheckEnemyVisible',actor:{SightCounter:5}}]});
add('pawn-timers-see-callback-writes',{PainTime:0.125,SpeechTime:1},{kind:'Pawn',callbacks:[
  {event:'PainTimer',actor:{SpeechTime:0.1}}]});
add('pawn-eyeheight-and-weapon',{pawnFlags:2,pawnFlags2:1,Location:[1,2,3]}, {kind:'Pawn',weapon:true});
add('pawn-viewrotation-copy',{pawnFlags:2,Rotation:[123,456,789],ViewRotation:[9,8,7]}, {kind:'Pawn'});
add('pawn-class-without-flag',{animFlags:1,PainTime:0.125},{kind:'Pawn'});
add('pawn-flag-without-class',{animFlags:0x800001,PainTime:0.125});
add('local-player-input',{pawnFlags:2},{kind:'PlayerPawn',viewport:true});
add('player-without-viewport',{pawnFlags:2},{kind:'PlayerPawn'});
add('camera-input-guard',{pawnFlags:2},{kind:'Camera',viewport:true});
add('camera-input-enabled',{pawnFlags:2,ShowFlags:0x800},{kind:'Camera',viewport:true});
const root=gameDirectory();
const reference=JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-actor-tick-oracle.py',root],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:8*1024*1024}));
if(process.argv.includes('--reference-only')) {
  await writeFile('.cache/research/actor-tick-original.json',JSON.stringify({cases,reference}));
  for(const value of reference.cases)console.log(value.name,value.result,
    value.events.filter(e=>!['FindFunction','FindFunctionChecked','IsProbing'].includes(e.op)).map(e=>e.op).join(' -> '));
  process.exit(0);
}
const {tickStandaloneActor}=await import('../src/runtime/actor-tick.mjs');
const {tickActorAnimation}=await import('../src/runtime/animation-tick.mjs');
const floats={LastRenderTime:0x34,DistanceFromPlayer:0x38,TimerRate:0x48,TimerCounter:0x4c,LifeSpan:0x50,
  AnimFrame:0x58,AnimRate:0x5c,TweenRate:0x60,AnimLast:0x220,AnimMinRate:0x224,OldAnimRate:0x228,
  SightCounter:0x320,PainTime:0x324,SpeechTime:0x328,TargetEyeHeight:0x870};
const vectors={Location:[0x114,false],Velocity:[0x144,false],Rotation:[0x120,true],ViewRotation:[0x3dc,true],
  TargetViewRotation:[0x864,true],TargetWeaponViewOffset:[0x874,false]};
const bytes={Physics:0x30,Role:0x31,RemoteRole:0x32},ints={ShowFlags:0x5fc};
const flags={bHidden:[0x28,2],bTicked:[0x28,0x200],bTimerLoop:[0x28,0x1000],
  bStasis:[0x28,0x200000],bForceStasis:[0x28,0x400000],bIsPawn:[0x28,0x800000],
  bTransient:[0x2c,2],bIsPlayer:[0x318,2],bAdvancedTactics:[0x318,0x80000000],
  bViewTarget:[0x31c,1]};
for(let i=0;i<cases.length;i++) {
  const sample=cases[i],original=reference.cases[i],buffer=Buffer.from(original.before,'hex');
  const actor={},target=sample.viewTarget?{...sample.viewTarget,kind:'Pawn',
    Weapon:sample.viewTarget.weaponOffset?{PlayerViewOffset:sample.viewTarget.weaponOffset}:null}:null;
  const read=(object,key)=>{
    if(object!==actor)return object[key];
    if(Object.hasOwn(floats,key))return buffer.readFloatLE(floats[key]);
    if(Object.hasOwn(bytes,key))return buffer[bytes[key]];
    if(Object.hasOwn(ints,key))return buffer.readInt32LE(ints[key]);
    if(Object.hasOwn(flags,key)){const [at,mask]=flags[key];return Boolean(buffer.readUInt32LE(at)&mask);}
    if(Object.hasOwn(vectors,key)){const [at,int]=vectors[key];return [0,1,2].map(n=>buffer[int?'readInt32LE':'readFloatLE'](at+n*4));}
    if(key==='Owner')return 'ownerTicked' in sample?{bTicked:sample.ownerTicked}:null;
    if(key==='Player')return sample.viewport?{}:null;
    if(key==='Weapon')return sample.weapon?{}:null;
    if(key==='ViewTarget')return target;
    throw new Error(`Unknown tick read ${key}`);
  };
  const write=(object,key,value)=>{
    assert.equal(object,actor);
    if(Object.hasOwn(floats,key))return buffer.writeFloatLE(value,floats[key]);
    if(Object.hasOwn(bytes,key)){buffer[bytes[key]]=value;return;}
    if(Object.hasOwn(flags,key)){
      const [at,mask]=flags[key];buffer.writeUInt32LE(((buffer.readUInt32LE(at)&~mask)|(value?mask:0))>>>0,at);return;
    }
    if(Object.hasOwn(vectors,key)){
      const [at,int]=vectors[key];value.forEach((item,n)=>buffer[int?'writeInt32LE':'writeFloatLE'](item,at+n*4));return;
    }
    throw new Error(`Unknown tick write ${key}`);
  };
  const events=[];let callbackIndex=0,weaponLocation=null;
  const event=(op,seconds=null)=>{
    events.push({op,seconds,...Object.fromEntries(['AnimFrame','TimerRate','TimerCounter','LifeSpan',
      'SightCounter','PainTime','SpeechTime'].map(key=>[key,read(actor,key)]))});
    const callback=sample.callbacks?.[callbackIndex];
    if(callback?.event===op){for(const [key,value] of Object.entries(callback.actor))write(actor,key,value);callbackIndex++;}
  };
  const animation={blends:Array.from({length:4},()=>({AnimSequence:'None'})),
    get AnimSequence(){return original.names[buffer.readUInt32LE(0x54)];},
    get animFlags(){return buffer.readUInt32LE(0x28);},set animFlags(value){buffer.writeUInt32LE(value>>>0,0x28);},
    get simAnim(){return Object.fromEntries(['frame','rate','tween','last'].map((key,n)=>[key,buffer.readFloatLE(0x22c+n*4)]));},
    set simAnim(value){['frame','rate','tween','last'].forEach((key,n)=>buffer.writeFloatLE(value[key],0x22c+n*4));},
    latentAction:0,isWeapon:false};
  for(const key of ['AnimFrame','AnimRate','TweenRate','AnimLast','AnimMinRate','OldAnimRate','Velocity','RemoteRole'])
    Object.defineProperty(animation,key,{get:()=>read(actor,key),set:value=>write(actor,key,value)});
  const sentinel={},level={timeSeconds:sample.timeSeconds??1,netMode:0,demoRecDriver:null,
    tickTag:sample.tickTag??1,deferredHead:sentinel,zoneLastRenderTime:()=>sample.zoneLastRenderTime??0};
  const result=tickStandaloneActor(actor,sample.seconds,sample.tickType??2,{
    read,write,level,isA:(object,key)=>{
      const kind=object===actor?sample.kind??'Actor':object.kind;
      return ({Actor:[],Pawn:['pawn'],PlayerPawn:['pawn','playerpawn'],Camera:['pawn','playerpawn','camera']}[kind]??[]).includes(key.split('.').at(-1));
    },
    isProbing:(_,name)=>{const result=!sample.disabledProbes?.includes(name);events.push({op:'IsProbing',name,result});return result;},
    allocateDeferredActor:()=>{const allocated=!sample.allocationFails;events.push({op:'DeferOwner',allocated});return allocated?{}:null;},
    advanceAnimation:(_,dt)=>tickActorAnimation(animation,dt,{mesh:()=>null,simulatedPawn:false,
      findFunction:name=>name,processEvent:name=>event(name)}),
    processEvent:(_,name,args)=>event(name,args[0]??null),processState:(_,dt)=>event('ProcessState',dt),
    performPhysics:(_,dt)=>event('PerformPhysics',dt),destroyActor:()=>event('DestroyActor'),
    readInput:(_,dt)=>event('ReadInput',dt),showSelf:()=>event('ShowSelf'),checkEnemyVisible:()=>event('CheckEnemyVisible'),
    farMoveActor:(_,location,test,noCheck)=>{assert.equal(test,0);assert.equal(noCheck,0);weaponLocation=location;event('FarMoveWeapon');},
  });
  const after=Buffer.from(original.after,'hex'),changed=[];
  for(let at=0;at<buffer.length;at+=4)if(buffer.readUInt32LE(at)!==after.readUInt32LE(at))
    changed.push({offset:at.toString(16),actual:buffer.readFloatLE(at),native:after.readFloatLE(at)});
  assert.deepEqual(changed,[],sample.name);
  assert.deepEqual(events,original.events.filter(e=>!['FindFunction','FindFunctionChecked'].includes(e.op)),sample.name);
  assert.equal(result,original.result,sample.name);assert.equal(callbackIndex,original.callbacks,sample.name);
  assert.equal(level.deferredHead?.actor===actor?'actor':null,original.deferred,sample.name);
  if(level.deferredHead?.actor===actor)assert.equal(level.deferredHead.next,sentinel);
  assert.equal(level.deferredHead===null,original.deferredHeadCleared,sample.name);
  assert.deepEqual(weaponLocation,original.weaponLocation,sample.name);
}
console.log(`PASS ${cases.length} original standalone Actor.Tick cases: full storage, admission/defer/stasis, animation/script/timer/physics order, lifespan, Pawn and player tails.`);
