/** Real Play integration for the Training Secretary0 patrol (Orders=Patrolling,
 * OrderTag=sec1). The original UGameEngine.LoadMap runs the PreBeginPlay pass
 * over the whole actor array (Engine.dll 0x1038d99a-0x1038d9cc), so
 * PatrolPoint.PreBeginPlay resolves each serialized Nextpatrol name into
 * NextPatrolPoint (native 304 AllActors tag lookup) and seeds
 * lookDir=200*vector(Rotation). That makes sec1<->sec2 a continuous two-point
 * route: PickDestination chains PatrolPoint4.NextPatrolPoint=PatrolPoint5 and
 * the secretary patrols back and forth, never reaching Standing.
 *
 * Each MoveToward leg is instrumented through pollPawnLocomotion to capture the
 * exact completion moment: the recovered steer/arrival helper (0x103be200)
 * clears the latent on arrival — horizontal distance <16u for PHYS_Walking
 * (the helper zeroes dz) — while MoveTimer>0 distinguishes arrival from
 * timeout. Load and the public game.reset() both re-run the chain. */
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
const level=runtime.levelFor(secretary),nav=runtime.pawnNavServices(secretary);
const point=name=>level.actors.find(actor=>actor?.name===name);
const [pp4,pp5,pp0,pp1]=['PatrolPoint4','PatrolPoint5','PatrolPoint0','PatrolPoint1'].map(point);
for(const pp of [pp4,pp5,pp0,pp1])assert.ok(pp,`00_Training must contain ${pp?.name}`);
const ref=(actor,name)=>runtime.namedReference(actor,name).get();
// PatrolPoint.PreBeginPlay ran on every map patrol point: Nextpatrol name ->
// NextPatrolPoint actor link, lookDir = 200*vector(Rotation) (|lookDir|=200).
assert.equal(ref(pp4,'NextPatrolPoint'),pp5,'PatrolPoint4.NextPatrolPoint resolves sec2');
assert.equal(ref(pp5,'NextPatrolPoint'),pp4,'PatrolPoint5.NextPatrolPoint resolves sec1');
assert.equal(ref(pp0,'NextPatrolPoint'),pp1,'PatrolPoint0.NextPatrolPoint resolves comp2');
assert.equal(ref(pp1,'NextPatrolPoint'),pp0,'PatrolPoint1.NextPatrolPoint resolves comp1');
for(const pp of [pp4,pp5]){
  const look=ref(pp,'lookDir');
  assert.ok(Math.abs(Math.hypot(...look)-200)<0.5,
    `${pp.name} lookDir is the PreBeginPlay 200*vector(Rotation) seed: ${look}`);
}
// Pin the live property adapter, not just the oracle's fabricated raw word.
// actorWorker reads target+0x1dc & 4 (0x103c0b26): bBlockActors. Plant2
// blocks actors but is deletable; LevelInfo has the opposite combination.
const plant=point('Plant2');
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
const stateName=()=>runtime.instance(secretary).state?.stateNode?.record?.name;
// Instrument the latent seam: a MoveToward poll that clears state.latent is a
// completion — capture the pawn/target geometry at that instant, before the
// script continues and rewrites MoveTarget.
let calls=0,successes=0;
const completions=[];
const invoke=runtime.invokeNative.bind(runtime);
runtime.invokeNative=call=>{
  const result=invoke(call);
  if(call.receiver===secretary&&call.index===517){calls++;if(result)successes++;}
  return result;
};
const pollLocomotion=runtime.pollPawnLocomotion.bind(runtime);
runtime.pollPawnLocomotion=call=>{
  const result=pollLocomotion(call);
  if(call.index===503&&call.receiver===secretary&&call.state.latent===0){
    const target=get('MoveTarget'),loc=get('Location');
    const tloc=target?ref(target,'Location'):null;
    completions.push({
      target:target?.name??null,
      horizontal:tloc?Math.hypot(loc[0]-tloc[0],loc[1]-tloc[1]):Infinity,
      vertical:tloc?Math.abs(loc[2]-tloc[2]):Infinity,
      physics:get('Physics'),
      moveTimer:get('MoveTimer'),
    });
  }
  return result;
};
const destSequence=[];
const trace=[];
let lastDest=null;
const patrol=(ticks)=>{
  for(let i=0;i<ticks&&!npcFailures.has(secretary);i++){
    game.tick(1/60,{});
    const dest=get('destPoint');
    assert.notEqual(stateName(),'Standing','patrol must not terminate in Standing');
    if(dest!==lastDest){destSequence.push(dest?.name??'null');lastDest=dest;}
    trace.push({location:[...get('Location')],physics:get('Physics'),
      state:stateName(),latent:runtime.instance(secretary).state.latent,
      target:get('MoveTarget')?.name??null,destination:dest?.name??null,
      moveTimer:get('MoveTimer')});
  }
};
// ~1900 ticks: land, arrive PatrolPoint4, pausetime pause, walk ~880u to
// PatrolPoint5, pause, depart back toward PatrolPoint4.
patrol(1900);
assert.equal(npcFailures.has(secretary),false,
  `Secretary0 ticked through startup and patrolling without a boundary: ${npcFailures.get(secretary)}`);
assert.ok(calls>0,'Patrolling reached native 517 in live ticking');
assert.ok(successes>0,'at least one recovered path search found a patrol point');
assert.deepEqual(destSequence,['PatrolPoint4','PatrolPoint5','PatrolPoint4'],
  `PickDestination chains NextPatrolPoint sec1->sec2->sec1: ${destSequence}`);
// Both legs terminate by the recovered walking arrival rule (horizontal
// <16u; dz is zeroed), with MoveTimer still positive and a live target.
function assertArrivals(){
  assert.ok(completions.length>=2,`expected arrivals at both patrol points: ${JSON.stringify(completions)}`);
  for(const c of completions){
    assert.ok(c.target,'MoveToward completion with a live target (not target loss)');
    assert.equal(c.physics,1,'patrol arrival uses PHYS_Walking');
    assert.ok(c.horizontal<16,`walking arrival tolerance: ${c.horizontal.toFixed(1)}u horizontal <16`);
    assert.ok(c.moveTimer>0,`arrival before MoveTimer expiry (${c.moveTimer.toFixed(2)}s remaining)`);
  }
  assert.ok(completions.some(c=>c.target==='PatrolPoint4'),'arrived at PatrolPoint4');
  assert.ok(completions.some(c=>c.target==='PatrolPoint5'),'arrived at PatrolPoint5');
  assert.equal(stateName(),'Patrolling','secretary is still patrolling');
}
assertArrivals();
const loadCompletions=structuredClone(completions),loadTrace=structuredClone(trace);
// Exercise the public reset entry point: it restores the random stream,
// collision state and clock before the doors subsystem replays startup.
game.reset();
assert.equal(ref(pp4,'NextPatrolPoint'),pp5,'reset re-runs PatrolPoint4.PreBeginPlay');
assert.ok(Math.abs(Math.hypot(...ref(pp4,'lookDir'))-200)<0.5,'reset re-derives lookDir');
assert.equal(stateName(),'StartUp','reset returns the secretary to StartUp');
completions.length=0;destSequence.length=0;trace.length=0;lastDest=null;
patrol(1900);
assert.equal(npcFailures.has(secretary),false,
  `post-reset patrol runs without a boundary: ${npcFailures.get(secretary)}`);
assertArrivals();
assert.deepEqual(destSequence,['PatrolPoint4','PatrolPoint5','PatrolPoint4'],
  `post-reset route repeats sec1->sec2->sec1: ${destSequence}`);
assert.deepEqual(completions,loadCompletions,'public reset reproduces both arrival geometries and timers');
assert.deepEqual(trace,loadTrace,'public reset reproduces the complete 1900-tick patrol trace');
console.log(`PASS Secretary0 patrol: ${successes}/${calls} FindPathToward, `+
  `${completions.length} post-reset arrivals, continuous sec1<->sec2 loop, load+reset verified.`);
