/** Compare level scheduling with complete original ULevel.Tick execution. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {gameDirectory} from './game-directory.mjs';

const cases=[];
const add=(name,actors={a:{},b:{}},extra={})=>cases.push({name,actors,...extra});
const defer=(...ids)=>({mark:false,result:0,actions:[{defer:ids}]});
add('ascending-order-null-slots-static-prefix',{static:{},a:{},b:{}},
  {slots:['LevelInfo','static','a',null,'b'],firstDynamicActor:2});
add('first-pass-reticks-duplicates',{a:{fields:{bTicked:true}}},{slots:['LevelInfo','a','a']});
add('append-actor-during-tick',{a:{steps:[{actions:[{append:['b']}]}]},b:{}},{slots:['LevelInfo','a']});
add('remove-future-slot',{a:{steps:[{actions:[{slot:[2,null]}]}]},b:{},c:{}});
add('replace-array-during-tick',{a:{steps:[{actions:[{array:['LevelInfo','a','c']}]}]},b:{},c:{}});
add('truncate-array-during-tick',{a:{steps:[{actions:[{array:['LevelInfo','a']}]}]},b:{}});
add('deferred-lifo-order',{a:{steps:[defer('a')]},b:{steps:[defer('b')]},owner:{}});
add('deferred-needs-second-pass',{a:{steps:[defer('a')]},b:{steps:[defer('b'),defer('b')]},owner:{}});
add('no-progress-no-retry',{a:{steps:[defer('a')]},b:{steps:[defer('b')]}});
add('zero-sum-progress-is-not-call-count',{a:{steps:[defer('a')]},b:{steps:[{result:1}]},c:{steps:[{result:-1}]}});
add('overflow-progress-wraps-zero',{a:{steps:[defer('a')]},b:{steps:[{result:2147483647}]},
  c:{steps:[{result:2147483647}]},d:{steps:[{result:2}]}});
add('deferred-entry-already-ticked-skips',{a:{steps:[{actions:[{defer:['a']}]}]}});
add('deferred-next-read-after-callback',{a:{steps:[defer('a')]},
  b:{steps:[defer('b'),{actions:[{cutNext:'b'}]}]},owner:{}});
add('frame-tag-zero',{a:{fields:{bTicked:true}},b:{fields:{bTicked:true}}},{tickTag:0});
add('distance-prepass-before-player-moves',{
  p:{playerPawn:true,controlled:true,fields:{Location:[100,20,30]},steps:[{actions:[{set:{p:{Location:[500,600,700]}}}]}]},
  a:{fields:{Location:[103,24,42]}},b:{fields:{Location:[-30.1234,10000.123,600.01]}}},{player:'p'});
add('distance-without-controlled-player',{p:{playerPawn:true},a:{}},{player:'p'});
add('distance-with-wrong-player-class',{p:{controlled:true},a:{}},{player:'p'});
add('clock-unrounded-time-dilation',undefined,{seconds:0.1234567,timeDilation:0.654321,timeSeconds:12345.6789123456});
add('clock-before-minimum-clamp',undefined,{seconds:0.001,timeDilation:0.5});
add('clock-before-maximum-clamp',undefined,{seconds:2,timeDilation:0.75});
add('zero-delta',undefined,{seconds:0});
add('negative-time-dilation',undefined,{timeDilation:-1});
add('time-only',undefined,{tickType:0,beforeActions:[{defer:['a']}]});
add('players-only-overrides-time-only',undefined,{tickType:0,playersOnly:true});
add('allocated-empty-pauser-suppresses-manager',undefined,{allocatedEmpty:true});
add('embedded-null-pauser-is-empty-c-string',undefined,{pauser:'\0JC'});
add('callback-pauses-before-event-manager',{a:{steps:[{actions:[{pauser:'JC'}]}]},b:{}});
add('no-event-manager',undefined,{eventManager:false});
add('paused-input-and-always-tick',{
  p:{playerPawn:true,controlled:true,alwaysTick:true,inputActions:[{set:{p:{inputs:[11,22,33,44,55,66]}}}]},
  a:{alwaysTick:true},b:{},uncontrolled:{playerPawn:true,alwaysTick:true}},
  {pauser:'JC',player:'p',slots:['LevelInfo','p',null,'a','b','uncontrolled']});
add('paused-preserves-deferred-no-retry',{a:{alwaysTick:true,steps:[defer('a')]},b:{alwaysTick:true}},
  {pauser:'JC',beforeActions:[{defer:['b']}]});
add('paused-time-only-input', {p:{playerPawn:true,controlled:true},a:{alwaysTick:true}}, {pauser:'JC',tickType:0});

const reference=JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-level-tick-oracle.py',gameDirectory()],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:8*1024*1024}));
if(process.argv.includes('--reference-only')) {
  await writeFile('.cache/research/level-tick-original.json',JSON.stringify({cases,reference}));
  for(const value of reference.cases)console.log(value.name,value.events.map(e=>e.actor??e.op).join(' -> '));
  process.exit(0);
}

const {tickStandaloneLevel}=await import('../src/runtime/level-tick.mjs');
const f=Math.fround;
const hex=(number,double=false)=>{
  const buffer=Buffer.alloc(double?8:4);buffer[double?'writeDoubleLE':'writeFloatLE'](number);return buffer.toString('hex');
};
for(let i=0;i<cases.length;i++) {
  const sample=cases[i],original=reference.cases[i];
  const buffers=Object.fromEntries(Object.entries(original.before).map(([id,bytes])=>[id,Buffer.from(bytes,'hex')]));
  const actors=Object.fromEntries(Object.keys(sample.actors).map(id=>[id,{id}]));
  const info={id:'LevelInfo',TimeDilation:f(sample.timeDilation??1),TimeSeconds:f(sample.timeSeconds??1),
    bPlayersOnly:sample.playersOnly??false,Pauser:sample.pauser??'',EventManager:sample.eventManager===false?null:{}};
  const ids=slots=>slots.map(id=>id==='LevelInfo'?info:actors[id]??null);
  const level={actors:ids(sample.slots??['LevelInfo',...Object.keys(actors)]),firstDynamicActor:sample.firstDynamicActor??1,
    tickTag:sample.tickTag??1,inTick:0,timeSeconds:sample.timeSeconds??1,netMode:0,netDriver:null,demoRecDriver:null,
    serviceAtF8:null,deferredHead:null,firstViewport:{actor:actors[sample.player]??null}};
  let allocatedEmpty=sample.allocatedEmpty??false,calendar;
  const nodes={},calls={},events=[],memoryToken={};
  const read=(actor,name)=>{
    if(actor===info)return info[name];
    const b=buffers[actor.id],spec=sample.actors[actor.id];
    if(name==='bTicked')return Boolean(b.readUInt32LE(0x28)&0x200);
    if(name==='bAlwaysTick')return Boolean(b.readUInt32LE(0x1a0)&0x20);
    if(name==='DistanceFromPlayer')return b.readFloatLE(0x38);
    if(name==='Location')return [0,1,2].map(i=>b.readFloatLE(0x114+i*4));
    if(name==='Player')return spec.controlled?level.firstViewport:null;
    throw new Error(name);
  };
  const write=(actor,name,value)=>{
    if(actor===info){info[name]=value;return;}
    const b=buffers[actor.id];
    if(name==='bTicked'){b.writeUInt32LE(((b.readUInt32LE(0x28)&~0x200)|(value?0x200:0))>>>0,0x28);return;}
    if(name==='DistanceFromPlayer'){b.writeFloatLE(value,0x38);return;}
    if(name==='Location'){value.forEach((v,i)=>b.writeFloatLE(v,0x114+i*4));return;}
    if(name==='inputs'){value.forEach((v,i)=>b.writeFloatLE(v,0x680+i*4));return;}
    throw new Error(name);
  };
  const snapshot=()=>({time:hex(level.timeSeconds,true),infoTime:hex(info.TimeSeconds),tickTag:level.tickTag,
    inTick:Number(level.inTick),distances:Object.fromEntries(Object.entries(actors).map(([id,a])=>[id,read(a,'DistanceFromPlayer')])),
    slots:level.actors.map(a=>a?.id??null)});
  const event=(op,extra={})=>events.push({op,...extra,...snapshot()});
  const actions=list=>{
    for(const action of list){
      if(action.array)level.actors=ids(action.array);
      if(action.append)level.actors=[...level.actors,...ids(action.append)];
      if(action.slot){const [i,id]=action.slot;level.actors[i]=actors[id]??null;}
      for(const id of action.defer??[])level.deferredHead=nodes[id]={actor:actors[id],next:level.deferredHead};
      if(action.cutNext)nodes[action.cutNext].next=null;
      for(const [id,values] of Object.entries(action.set??{}))for(const [key,value] of Object.entries(values))write(actors[id],key,value);
      if(Object.hasOwn(action,'pauser')){info.Pauser=action.pauser;allocatedEmpty=action.allocatedEmpty??false;}
    }
  };
  actions(sample.beforeActions??[]);
  tickStandaloneLevel(level,sample.seconds??0.125,sample.tickType??2,{
    read,write,isA:(actor,cls)=>cls==='engine.levelinfo'?actor===info:sample.actors[actor.id]?.playerPawn??false,
    beginTick:()=>{event('BeginTick');return memoryToken;},
    endTick:(_,token)=>{assert.equal(token,memoryToken);event('EndTick');},
    updateTime:()=>{calendar=[2026,9,6,19,12,34,56,789];event('SystemTime');},
    pauserArrayCount:()=>info.Pauser.length?info.Pauser.length+1:allocatedEmpty?1:0,
    tickActor:(actor,seconds,type)=>{
      const id=actor.id;event('ActorTick',{actor:id,seconds,type});
      const step=sample.actors[id].steps?.[calls[id]??0]??{};calls[id]=(calls[id]??0)+1;
      if(step.mark!==false)write(actor,'bTicked',Boolean(level.tickTag));
      actions(step.actions??[]);return step.result??1;
    },
    readInput:(_,seconds)=>event('ReadInput',{seconds}),
    processEvent:(actor,name,[seconds])=>{assert.equal(name,'PlayerInput');event(name,{actor:actor.id,seconds});actions(sample.actors[actor.id].inputActions??[]);},
    resetInputProperties:actor=>{for(const at of [0x680,0x684,0x694])buffers[actor.id].writeUInt32LE(0,at);},
    tickEventManager:(manager,seconds)=>{assert.equal(manager,info.EventManager);event('EventManager',{seconds});actions(sample.eventActions??[]);},
    cleanupDestroyed:(_,force)=>{assert.equal(force,0);event('CleanupDestroyed');},
  });
  assert.deepEqual(events,original.events,sample.name);
  assert.deepEqual(snapshot(),original.final,sample.name);
  assert.deepEqual(calendar,original.calendar,sample.name);
  for(const [id,buffer] of Object.entries(buffers))assert.equal(buffer.toString('hex'),original.after[id],`${sample.name}: ${id} full storage`);
  const chain=[];for(let node=level.deferredHead;node;node=node.next)chain.push(node.actor.id);
  assert.deepEqual(chain,original.deferred,sample.name);
}
console.log(`PASS ${cases.length} original complete ULevel.Tick references: live actor order/mutation, deferred retries, clock bits, player distances, pause/input, event/cleanup ordering.`);
