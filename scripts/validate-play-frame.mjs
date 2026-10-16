/** Play admission boundary; original clock/order evidence: script-level-tick.md. */
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
const runtime=game.doors.scriptRuntime.runtime,level=runtime.levelFor(game.player.collisionActor);
const time=runtime.namedReference(level.actors[0],'TimeSeconds');
const dilation=runtime.namedReference(level.actors[0],'TimeDilation');
const tickActor=runtime.processActorTick.bind(runtime),calls=[];
const processEvent=runtime.processEvent.bind(runtime);
let playerTicks=0;
runtime.processEvent=(actor,name,...args)=>{
  if(actor===game.player.collisionActor && name==='PlayerTick') playerTicks++;
  return processEvent(actor,name,...args);
};
runtime.processActorTick=(actor,seconds,options)=>{
  // Whether the owner had already ticked this frame when the call began (the
  // recovered owner-deferral test compares Owner.bTicked with TickTag).
  const owner=runtime.namedReference(actor,'Owner').get();
  const ownerTicked=owner?Number(Boolean(runtime.namedReference(owner,'bTicked').get()))===options?.level?.tickTag:true;
  const result=tickActor(actor,seconds,options);calls.push({actor,seconds,result,ownerTicked});return result;
};
const hudTick=game.hud.tick.bind(game.hud),hudDeltas=[];
game.hud.tick=dt=>{hudDeltas.push(dt);return hudTick(dt);};
const levelTick=runtime.processLevelTick.bind(runtime),levelCalls=[];
runtime.processLevelTick=(world,seconds,options)=>{
  assert.strictEqual(world,level,'scheduler owns the actual scene level');
  levelCalls.push({seconds,actors:world.actors.slice(world.firstDynamicActor).filter(Boolean)});
  return levelTick(world,seconds,options);
};

// Binary-exact intervals isolate the integration from arithmetic already
// checked by the original ULevel.Tick oracle. Slow frames do not replay NPCs.
const pickups=level.actors.filter(actor=>actor&&runtime.readNamed(actor,'Physics')===2&&
  actor.lineage?.includes('engine.inventory'));
assert.ok(pickups.length>0);
const initialVelocity=pickups.map(actor=>runtime.readNamed(actor,'Velocity').slice());
game.tick(1/120,{});
// Render-side out parameters must receive PlayerCalcView's original bytecode
// result. This catches accidentally reading the retired host yaw/pitch path.
const view=game.view(),pawn=game.player.collisionActor;
const location=runtime.readNamed(pawn,'Location'),bob=runtime.readNamed(pawn,'WalkBob');
assert.ok(view.actor===pawn);
assert.deepEqual(view.rotation,runtime.readNamed(pawn,'ViewRotation'));
assert.deepEqual(view.location,[Math.fround(location[0]+bob[0]),Math.fround(location[1]+bob[1]),
  Math.fround(Math.fround(location[2]+runtime.readNamed(pawn,'EyeHeight'))+bob[2])]);
assert.equal(view.fov,runtime.readNamed(pawn,'FOVAngle'));
assert.ok(pickups.some((actor,i)=>runtime.readNamed(actor,'Velocity').some((v,k)=>v!==initialVelocity[i][k])),
  'previously omitted map pickups actually fall');
game.reset();
pickups.forEach((actor,i)=>assert.deepEqual(runtime.readNamed(actor,'Velocity'),initialVelocity[i],
  `${actor.name}: reload restores native velocity as well as script storage`));
let elapsed=0;
for(const [seconds,scale,expected] of [[1/64,1,1/64],[1/8,1,1/8],[1,1,Math.fround(.4)],
  [1/1024,1,Math.fround(.005)],[1/8,.5,1/16]]) {
  dilation.set(scale);calls.length=0;hudDeltas.length=0;
  const steps=playerTicks;
  game.tick(seconds,{});elapsed+=seconds*scale;
  assert.equal(levelCalls.at(-1).seconds,seconds,'host passes the unscaled input once');
  for(const actor of levelCalls.at(-1).actors)
    assert.ok(calls.some(call=>call.actor===actor)||!level.actors.includes(actor),
      `every dynamic slot ticks unless destroyed before its turn: ${actor.name}`);
  assert.equal(playerTicks,steps+1,'one player tick per host frame');
  assert.ok(calls.length>0,'supported NPCs still tick');
  // An owner-deferred actor (the player's carried key ring) returns 0 from its
  // first Actor.Tick and is retried from ULevel::Tick's deferred list once its
  // owner has ticked (docs/script-level-tick.md); no actor completes twice.
  // An owner that skipped its own tick (the stasis return precedes the
  // bTicked write) keeps its items deferred, exactly like the original.
  const completed=calls.filter(call=>call.result!==0);
  assert.equal(new Set(completed.map(call=>call.actor)).size,completed.length,'no NPC catch-up loop');
  const incomplete=calls.filter(call=>call.result===0&&!completed.some(done=>done.actor===call.actor));
  assert.ok(incomplete.every(call=>!call.ownerTicked&&
    runtime.namedReference(call.actor,'Owner').get()!==game.player.collisionActor),
    'only actors whose owner skipped its own tick stay deferred');
  assert.ok(calls.every(call=>call.seconds===expected));
  // The window system ticks on the host's real time, not the level's dilated, clamped delta: UExtensionEngine::Tick -> TickWindows ->
  // GetWindowsTickOffset(1) (docs/interface-frames.md "Window ticks are real time").
  assert.deepEqual(hudDeltas,[seconds],'HUD ticks on the unscaled, unclamped host delta');
  assert.equal(level.timeSeconds,elapsed,'double clock advances before the actor clamp');
  assert.equal(time.get(),Math.fround(elapsed),'scripts see the current level time');
}
game.reset();playerTicks=0;assert.equal(level.timeSeconds,0);assert.equal(time.get(),0);
dilation.set(1);calls.length=0;
game.tick(1/64,{});
assert.ok(calls.length>0);assert.equal(playerTicks,1);
assert.equal(level.timeSeconds,1/64);

// New integration boundary: paused ULevel.Tick still dispatches the original
// PlayerInput and only bAlwaysTick actors; it never dispatches PlayerTick.
const always=level.actors.find(actor=>actor?.name==='LightSwitch0');
assert.ok(always);runtime.writeNamed(always,'bAlwaysTick',true);
runtime.writeNamed(level.actors[0],'Pauser','JC');
runtime.writeNamed(game.player.collisionActor,'aForward',123);
const steps=playerTicks;calls.length=0;
game.tick(1/64,{});
assert.equal(playerTicks,steps);
assert.ok(calls.some(call=>call.actor===always));
assert.ok(calls.every(call=>runtime.readNamed(call.actor,'bAlwaysTick')));
assert.equal(runtime.readNamed(game.player.collisionActor,'aForward'),0);
runtime.writeNamed(level.actors[0],'Pauser','');

// A failed actor stops the whole frame and remains a boundary, never an
// exclusion on the next tick. This tests host failure handling, not fidelity.
const boundary=new Error('integration boundary'),beforeFailure=runtime.processActorTick;
let attempts=0;
runtime.processActorTick=(actor,...rest)=>{
  attempts++;
  if(actor===always)throw boundary;
  return beforeFailure(actor,...rest);
};
assert.throws(()=>game.tick(1/64,{}),error=>error===boundary);
const stopped=attempts;
assert.throws(()=>game.tick(1/64,{}),error=>error===boundary);
assert.equal(attempts,stopped,'partially advanced frame never resumes');
console.log('PASS Play full-level scheduling: real dynamic slots, shared clock/delta, owner retries, paused input/bAlwaysTick, reset and explicit failure pause.');
