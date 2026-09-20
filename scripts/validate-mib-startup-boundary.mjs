/** Real Play integration for the recovered alliance natives and the wired
 * AIPickRandomDestination(709): the Training MIB lands, ticks through its
 * Wandering.PickDestination episodes, and — once a search succeeds — walks.
 * ScriptedPawn ambient PlaySound(264) sites are recorded nonfatal boundaries;
 * SpawnNotification never dispatches (no pawn class declares it — the
 * original's FindFunctionChecked miss is logged and the AActor::ProcessEvent
 * level-flag gate drops the NULL). */
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1,presentation:true});
const {runtime,npcPawns,npcFailures}=game.doors.scriptRuntime;
const mib=npcPawns.find(actor=>actor.name==='mib1');
assert.ok(mib);
const get=name=>runtime.namedReference(mib,name).get();
const invoke=runtime.invokeNative.bind(runtime);
let enemyChecks=0,picks=0,successes=0;
runtime.invokeNative=call=>{
  const result=invoke(call);
  if(call.receiver===mib){
    if(call.index===2105)enemyChecks++;
    if(call.index===709){picks++;if(result)successes++;}
  }
  return result;
};
for(let run=0;run<2;run++) {
  if(run)game.reset();
  enemyChecks=0;picks=0;successes=0;
  assert.equal(npcFailures.has(mib),false);
  game.tick(1/60,{});
  assert.equal(get('AnimSequence').toLowerCase(),'breathelight');
  const firstFrame=get('AnimFrame');
  assert.ok(firstFrame<0,'original startup selected a tween');
  const spawn=[...mib.position];
  // Wander episodes pause ~6.5s between attempts on failure; seed 1 first
  // succeeds around tick 559. 900 ticks covers two-plus episodes with margin.
  for(let i=0;i<900&&!npcFailures.has(mib);i++)game.tick(1/60,{});
  assert.equal(npcFailures.has(mib),false,'MIB ticked through startup and wandering without a boundary');
  assert.ok(enemyChecks>0,'real script dispatch completed the recovered enemy native');
  assert.equal(get('Physics'),1,'MIB landed and stayed in PHYS_Walking');
  assert.ok(get('AnimFrame')>=0,'startup tween finished — the pawn is no longer frozen mid-pose');
  assert.ok(picks>0,'Wandering.PickDestination reached native 709 in live ticking');
  assert.ok(successes>0,'at least one recovered search found a destination');
  const moved=Math.hypot(...mib.position.map((v,i)=>v-spawn[i]));
  assert.ok(moved>0.5,`MIB walked ${moved.toFixed(1)} units from spawn`);
  console.log(`PASS MIB ${run?'reset':'load'}: ${enemyChecks} enemy checks, ${successes}/${picks} successful picks, moved ${moved.toFixed(1)}u.`);
}
