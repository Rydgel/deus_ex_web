/** Review regressions at the original-instruction/live-host boundary. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {actorInStasis} from '../src/runtime/actor-tick.mjs';
import {actorRenderFeedback} from '../src/viewer/actor-render-feedback.mjs';
import {gameDirectory} from './game-directory.mjs';

const {createGame}=await import(process.env.LOADMAP_GAME_MODULE
  ?pathToFileURL(resolve(process.env.LOADMAP_GAME_MODULE)) :new URL('../src/viewer/game.mjs',import.meta.url));
const root=gameDirectory(),files=[];
const oracle=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-loadmap-state-oracle.py',root],{encoding:'utf8'}));
assert.deepEqual(oracle,{touching:[0,0,0,0],neighbor:555,drawn:17.125,undrawn:-10});
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training'),map=decodeMap(asset.bytes);
const events=new Set(['PreBeginPlay','BeginPlay','PostBeginPlay','SetInitialState','PostPostBeginPlay']);
let trace=[],touching=[];
const processEvent=ScriptRuntime.prototype.processEvent;
const init=ScriptRuntime.prototype.initExecution;
ScriptRuntime.prototype.initExecution=function(actor,...args){
  trace.push({actor,event:'InitExecution'});
  if(actor.name==='Secretary0')touching.push([...this.namedReference(actor,'Touching').get()]);
  return init.call(this,actor,...args);
};
ScriptRuntime.prototype.processEvent=function(actor,event,...args){
  if(events.has(event))trace.push({actor,event});
  return processEvent.call(this,actor,event,...args);
};
const failures=[];
function check(name,fn){try{fn();console.log(`PASS ${name}`);}catch(error){failures.push(error);console.error(`FAIL ${name}: ${error.message}`);}}
try{
  const game=await createGame(map,asset,assets,{randomSeed:1,presentation:true});
  const {runtime,npcPawns,npcFailures}=game.doors.scriptRuntime;
  const level=runtime.levelFor(game.player.collisionActor);
  const read=(actor,name)=>runtime.namedReference(actor,name).get();
  const point=level.actors.find(actor=>actor?.name==='PatrolPoint4');
  const secretary=npcPawns.find(actor=>actor.name==='Secretary0');
  const admitted=new Set([...npcPawns,...level.actors.filter(actor=>{
    if(!actor)return false;
    for(let cls=runtime.instance(actor).cls;cls;cls=cls.base)if(cls.record.key==='engine.patrolpoint')return true;
    return false;
  })]);
  const mapOrder=new Map(map.level.actors.map((ref,index)=>[ref,index]));
  const ordered=[...admitted].sort((a,b)=>mapOrder.get(a.index)-mapOrder.get(b.index));
  const expected=['InitExecution',...events].flatMap(event=>ordered.map(actor=>({actor:actor.name,event})));
  const admittedTrace=()=>trace.filter(({actor})=>admitted.has(actor)).map(({actor,event})=>({actor:actor.name,event}));
  check('fresh startup follows original shared passes and authored slot order',()=>assert.deepEqual(admittedTrace(),expected));
  const allMap = new Set(trace.filter(({actor,event})=>event==='InitExecution'
    && actor!==game.player.collisionActor && mapOrder.has(actor.index)).map(({actor})=>actor));
  assert.equal(allMap.size,312,'all original admitted exports, including the self-destroying PickupDistributor');
  const allOrdered=[...allMap].sort((a,b)=>mapOrder.get(a.index)-mapOrder.get(b.index));
  const allExpected=['InitExecution',...events].flatMap(event=>allOrdered.map(actor=>({actor:actor.name,event})));
  const allTrace=()=>trace.filter(({actor})=>allMap.has(actor)).map(({actor,event})=>({actor:actor.name,event}));
  check('every serialized actor receives each shared pass exactly once',()=>assert.deepEqual(allTrace(),allExpected));
  assert.equal(game.doors.scriptRuntime.loadMapStartupExclusions().length,0);


  const hidden=level.actors.filter(actor=>actor&&read(actor,'bHidden'));
  const oldHidden=hidden.map(actor=>read(actor,'LastRenderTime'));
  const light=level.actors.find(actor=>actor?.name==='LightSwitch0');
  const gate={timeSeconds:0,netMode:0,zoneLastRenderTime:()=>0};
  assert.equal(actorInStasis(light,{read,level:gate}),true,'distant undrawn LightSwitch is stasis-eligible');
  const tickActor=runtime.processActorTick;
  let tickLevel;
  runtime.processActorTick=function(actor,seconds,options){
    tickLevel=options.level;return tickActor.call(this,actor,seconds,options);
  };
  try{game.tick(1/60,{});}finally{runtime.processActorTick=tickActor;}
  gate.timeSeconds=read(level.actors[0],'TimeSeconds');
  check('headless tick never stamps hidden actors',()=>assert.deepEqual(hidden.map(actor=>read(actor,'LastRenderTime')),oldHidden));
  check('headless tick preserves original stasis eligibility',()=>assert.equal(actorInStasis(light,{read,level:gate}),true));
  level.zoneLastRenderTimes.fill(7.5);
  check('NPC tick reads model zone storage independently of ZoneInfo actors',()=>
    assert.equal(tickLevel.zoneLastRenderTime(light),7.5));
  runtime.namedReference(level.actors[0],'TimeSeconds').set(oracle.drawn);
  actorRenderFeedback(runtime,light)();
  check('actual draw notification matches original actor timestamp copy',()=>assert.equal(read(light,'LastRenderTime'),oracle.drawn));
  actorRenderFeedback(runtime,point)();
  check('hidden actor notification cannot stamp render time',()=>assert.equal(read(point,'LastRenderTime'),oracle.undrawn));

  // Restore a nonzero fourth serialized contact, then observe it at the first
  // startup callback. This catches the off-by-one in the original translation.
  secretary.values['Touching[3]']=point.index;
  trace=[];touching=[];
  game.reset();
  check('all four restored Touching slots clear before InitExecution',()=>
    assert.deepEqual(touching.map(slots=>slots.map(actor=>actor?.name??null)),[oracle.touching.map(()=>null)]));
  check('public reset replays the complete authored startup sequence',()=>assert.deepEqual(admittedTrace(),expected));
  check('reset reaches every serialized actor exactly once per pass',()=>assert.deepEqual(allTrace(),allExpected));
  check('startup creates no failures',()=>assert.deepEqual([...npcFailures].map(([a,e])=>[a.name,e]),[]));
  check('public reset restores transient zone stamps independently',()=>assert.ok(level.zoneLastRenderTimes.every(time=>time===0)));
}finally{
  ScriptRuntime.prototype.processEvent=processEvent;
  ScriptRuntime.prototype.initExecution=init;
}
assert.equal(failures.length,0,`${failures.length} LoadMap regressions`);
