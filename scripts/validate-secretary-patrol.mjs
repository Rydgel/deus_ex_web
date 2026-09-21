/** Real Play integration for native Pawn.FindPathToward (517): the Training
 * Secretary0 (Orders=Patrolling, OrderTag=sec1) ticks through its
 * Patrolling.BeginState patrol script, which reaches FindPathToward for the
 * lone sec1 PatrolPoint4 ~33 units from spawn — the only nav-graph node inside
 * the native 800uu candidate radius, so a direct reach is the sole possible
 * answer.  The recovered worker runs on the serialized nav graph
 * (NavigationPointList, upstreamPaths/Paths/PrunedPaths, the ULevel ReachSpec
 * table) through the shared pawnNavServices seam; the patrol script then runs
 * MoveToward and — after the patrol episode — lands in the scripted Standing
 * terminus (PatrolPoint4.NextPatrolPoint==None -> PickDestination ->
 * GotoState('Standing')). The current run moves 3.8u and stops ~28u from
 * PatrolPoint4. This route-selection check does not establish original
 * patrol-arrival fidelity: arrival tolerances, latent polling and the
 * movement/timeout trace still need comparison with the original. */
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
const secretary=npcPawns.find(actor=>actor.name==='Secretary0');
assert.ok(secretary,'00_Training must contain Secretary0');
// Pin the live property adapter, not just the oracle's fabricated raw word.
// actorWorker reads target+0x1dc & 4 (0x103c0b26): bBlockActors. Plant2
// blocks actors but is deletable; LevelInfo has the opposite combination.
const level=runtime.levelFor(secretary),nav=runtime.pawnNavServices(secretary);
const plant=level.actors.find(actor=>actor?.name==='Plant2');
assert.ok(plant,'00_Training must contain Plant2');
for(const [actor,blocks,noDelete] of [[plant,true,false],[level.actors[0],false,true]]){
  const read=name=>runtime.namedReference(actor,name).get();
  assert.equal(read('bBlockActors'),blocks,`${actor.name} authored bBlockActors`);
  assert.equal(read('bNoDelete'),noDelete,`${actor.name} authored bNoDelete`);
  const expected=Number(read('bCollideActors'))|Number(read('bCollideWorld'))<<1|
    Number(blocks)<<2|Number(read('bBlockPlayers'))<<3;
  assert.equal(nav.read(actor,'Flags1dc')&15,expected,`${actor.name} live native collision bits`);
}
const get=name=>runtime.namedReference(secretary,name).get();
const invoke=runtime.invokeNative.bind(runtime);
let calls=0,successes=0;
runtime.invokeNative=call=>{
  const result=invoke(call);
  if(call.receiver===secretary&&call.index===517){calls++;if(result)successes++;}
  return result;
};
const spawn=[...secretary.position];
// Patrol episodes tick the Secretary toward PatrolPoint4; 1200 ticks covers
// the startup tween, the first FindPathToward call and the short walk.
for(let i=0;i<1200&&!npcFailures.has(secretary);i++)game.tick(1/60,{});
assert.equal(npcFailures.has(secretary),false,
  `Secretary0 ticked through startup and patrolling without a boundary: ${npcFailures.get(secretary)}`);
assert.ok(calls>0,'Patrolling reached native 517 in live ticking');
assert.ok(successes>0,'at least one recovered path search found the patrol point');
// Single-point patrol: after the episode, PickDestination reads
// PatrolPoint4.NextPatrolPoint (None) and the script lands in Standing.
assert.equal(runtime.instance(secretary).state?.stateNode?.record?.name,'Standing',
  'single-point patrol terminates in the designed Standing state');
const moved=Math.hypot(...secretary.position.map((v,i)=>v-spawn[i]));
assert.ok(moved>0.5,`Secretary0 moved ${moved.toFixed(1)} units from spawn`);
console.log(`PASS Secretary0 patrol: ${successes}/${calls} successful FindPathToward calls, moved ${moved.toFixed(1)}u.`);
