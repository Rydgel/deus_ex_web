/** Original complete Pawn tick visibility helpers, including their LOS worker. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {gameDirectory} from './game-directory.mjs';

const cases=[],shown={fields:{Location:[100,0,0]}},listener={};
const show=(name,actors={shown,a:listener},extra={})=>cases.push({name,body:'ShowSelf',this:'shown',
  actors,pawnList:Object.keys(actors),...extra});
const enemy=(name,fields={},extra={})=>cases.push({name,body:'CheckEnemyVisible',this:'a',
  actors:{shown,a:{fields:{Enemy:'shown',...fields}}},...extra});
show('empty-pawn-list',undefined,{pawnList:[]});
show('only-self',{shown});
show('visible-listener');
show('zero-positive-and-disabled',{shown,zero:{fields:{SightCounter:0}},positive:{fields:{SightCounter:0.1}},off:{probe:false}});
show('unordered-sight-counter',{shown,a:{fields:{SightCounterBits:0x7fc12345}}});
show('blocked-corner',undefined,{fastLine:[0]});
show('opposite-los-flag-top-path',{shown,a:{fields:{bLOSflag:true}}});
show('blocked-top-and-corners',{shown,a:{fields:{bLOSflag:true}}},{fastLine:[0,0,0]});
show('behind-listener-fov-reject',{shown:{fields:{Location:[-100,0,0]}},a:{fields:{PeripheralVision:0.5}}},{fastLine:[]});
show('enemy-overrides-fov',{shown:{fields:{Location:[-100,0,0]}},a:{fields:{Enemy:'shown',PeripheralVision:0.5}}});
show('sight-radius-reject',{shown:{fields:{Location:[3000,0,0]}},a:{}},{fastLine:[]});
show('far-random-reject',{shown:{fields:{Location:[1500,0,0]}},a:{}},{fastLine:[],rand:[0.25]});
show('far-random-admits',{shown:{fields:{Location:[1500,0,0]}},a:{}},{rand:[0.75]});
show('no-extra-hidden-health-filter',{shown:{fields:{...shown.fields,bHidden:true}},a:{fields:{bHidden:true}}});
show('callback-skips-next-listener',{shown,a:{},b:{},c:{}},{fastLine:[1,1],callbacks:{
  'a.SeePlayer':[{set:{a:{nextPawn:'c'}}}]}});
show('callback-appends-listener',{shown,a:{},b:{}},{pawnList:['shown','a'],fastLine:[1,1],callbacks:{
  'a.SeePlayer':[{set:{a:{nextPawn:'b'}}}]}});
show('callback-head-change-does-not-restart',{shown,a:{},b:{}},{fastLine:[1,1],callbacks:{
  'a.SeePlayer':[{head:null}]}});
show('callback-updates-next-counter',{shown,a:{},b:{}},{callbacks:{
  'a.SeePlayer':[{set:{b:{SightCounter:0.2}}}]}});
enemy('no-enemy',{Enemy:null},{fastLine:[]});
enemy('visible-enemy-stamps-double-clock');
enemy('visible-enemy-second-trace',{}, {fastLine:[0,1]});
enemy('blocked-enemy-callback',{}, {fastLine:[0,0,0,0,0],callbacks:{
  'a.EnemyNotVisible':[{set:{a:{Enemy:null,LastSeenTime:7,SightCounter:0.9}}}]}});
enemy('enemy-outside-distance-cap',{}, {actors:{shown:{fields:{Location:[5000,0,0]}},a:{fields:{Enemy:'shown'}}},fastLine:[]});
enemy('invalid-enemy-assertion-boundary',{}, {actors:{shown:{...shown,valid:false},a:{fields:{Enemy:'shown'}}}});

const reference=JSON.parse(execFileSync(process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-pawn-tick-visibility-oracle.py',gameDirectory()],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:8*1024*1024}));
if(process.argv.includes('--reference-only')) {
  await writeFile('.cache/research/pawn-tick-visibility-original.json',JSON.stringify({cases,reference}));
  for(const result of reference.cases)console.log(result.name,result.events.map(e=>`${e.actor??''}:${e.op}`).join(' -> '));
  process.exit(0);
}
const {showPawnSelf,checkPawnEnemyVisible}=await import('../src/runtime/script-pawn-perception.mjs');
const floats={SightCounter:0x320,LastSeenTime:0x3c8,Stimulus:0x3a0,SightRadius:0x3a4,
  PeripheralVision:0x3a8,BaseEyeHeight:0x3f4,CollisionRadius:0x1d4,CollisionHeight:0x1d8,Skill:0x458};
const vectors={Location:0x114,LastSeenPos:0x3b0,LastSeeingPos:0x3bc};
const flags={bIsPlayer:[0x318,2],bLOSflag:[0x318,0x80000],bHidden:[0x28,2]};
const refs={Enemy:0x3cc,nextPawn:0x498};
for(let i=0;i<cases.length;i++) {
  const sample=cases[i],original=reference.cases[i];
  const buffers=Object.fromEntries(Object.entries(original.before).map(([id,bytes])=>[id,Buffer.from(bytes,'hex')]));
  const actors=Object.fromEntries(Object.keys(sample.actors).map(id=>[id,{id}]));
  const byPointer=Object.fromEntries(Object.entries(original.addresses).map(([id,address])=>[address,actors[id]]));
  const levelInfo={},level={actors:[levelInfo],pawnList:actors[sample.pawnList?.[0]]??null,
    timeSeconds:sample.timeSeconds??12345.678912345,model:{}};
  const read=(actor,key)=>{
    const b=buffers[actor.id];
    if(Object.hasOwn(floats,key))return b.readFloatLE(floats[key]);
    if(Object.hasOwn(vectors,key))return [0,1,2].map(i=>b.readFloatLE(vectors[key]+i*4));
    if(Object.hasOwn(flags,key)){const [at,mask]=flags[key];return Boolean(b.readUInt32LE(at)&mask);}
    if(Object.hasOwn(refs,key))return byPointer[b.readUInt32LE(refs[key])]??null;
    if(key==='Visibility')return b[0x398];
    if(key==='Rotation')return [0,0,0];
    throw new Error(key);
  };
  const write=(actor,key,value)=>{
    const b=buffers[actor.id];
    if(Object.hasOwn(floats,key))return b.writeFloatLE(value,floats[key]);
    if(Object.hasOwn(vectors,key)){value.forEach((v,i)=>b.writeFloatLE(v,vectors[key]+i*4));return;}
    if(Object.hasOwn(flags,key)){
      const [at,mask]=flags[key];b.writeUInt32LE(((b.readUInt32LE(at)&~mask)|(value?mask:0))>>>0,at);return;
    }
    if(Object.hasOwn(refs,key)){b.writeUInt32LE(value?original.addresses[value.id]:0,refs[key]);return;}
    throw new Error(key);
  };
  const state=()=>Object.fromEntries(Object.entries(actors).map(([id,actor])=>[id,{
    SightCounter:buffers[id].subarray(0x320,0x324).toString('hex'),
    LastSeenTime:buffers[id].subarray(0x3c8,0x3cc).toString('hex'),
    Stimulus:buffers[id].subarray(0x3a0,0x3a4).toString('hex'),bLOSflag:read(actor,'bLOSflag'),
  }]));
  const events=[];let traceCount=0,randomCount=0;
  const event=(op,extra={})=>events.push({op,...extra,state:state()});
  const services={read,write,level:()=>level,levelInfo:l=>l.actors[0],pawnList:l=>l.pawnList,
    nextPawn:a=>read(a,'nextPawn'),model:l=>l.model,timeSeconds:l=>l.timeSeconds,
    isA:(actor,name)=>name==='LevelInfo'?actor===levelInfo:actor!==levelInfo&&name==='Pawn',
    isProbing:(actor,name)=>{assert.equal(name,'SeePlayer');const result=sample.actors[actor.id].probe??true;
      event('IsProbing',{actor:actor.id,result});return result;},
    isValid:actor=>{const result=sample.actors[actor.id].valid??true;event('IsValid',{actor:actor.id,result});return result;},
    failAssert:line=>event('FailAssert',{line}),
    findFunctionChecked:(actor,name)=>{event('FindFunctionChecked',{actor:actor.id,name});return name;},
    processEvent:(actor,name,args)=>{
      event(name,{actor:actor.id,args:args.map(a=>a.id)});
      for(const action of sample.callbacks?.[`${actor.id}.${name}`]??[]) {
        for(const [id,fields] of Object.entries(action.set??{}))for(const [key,value] of Object.entries(fields))
          write(actors[id],key,Object.hasOwn(refs,key)?actors[value]??null:value);
        if(Object.hasOwn(action,'head'))level.pawnList=actors[action.head]??null;
        if(Object.hasOwn(action,'timeSeconds'))level.timeSeconds=action.timeSeconds;
      }
    },
    fastLineCheck:(model,end,start)=>{assert.equal(model,level.model);const result=(sample.fastLine??[1])[traceCount++];
      assert.notEqual(result,undefined,sample.name);event('FastLineCheck',{end,start,result});return result;},
    rand:()=>{const value=Math.fround((sample.rand??[])[randomCount++]);assert.ok(Number.isFinite(value));event('Rand',{value});return value;},
  };
  (sample.body==='ShowSelf'?showPawnSelf:checkPawnEnemyVisible)(actors[sample.this],services);
  // LOS entry is observed by the native oracle, not a replacement worker.
  // All actual LOS trace/state/RNG results are compared on both sides.
  assert.deepEqual(events,original.events.filter(e=>e.op!=='LOS'),sample.name);
  assert.equal(traceCount,original.traceCount,sample.name);assert.equal(randomCount,original.randomCount,sample.name);
  assert.equal(level.pawnList?.id??null,original.head,sample.name);
  for(const [id,buffer] of Object.entries(buffers))assert.equal(buffer.toString('hex'),original.after[id],`${sample.name}: ${id} complete storage`);
}
console.log(`PASS ${cases.length} original Pawn visibility helper cases with complete LOS execution: probes, live list mutations, rays/RNG, callback order and complete actor storage.`);
