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
runtime.processActorTick=(actor,seconds,options)=>{
  // Whether the owner had already ticked this frame when the call began (the
  // recovered owner-deferral test compares Owner.bTicked with TickTag).
  const owner=runtime.namedReference(actor,'Owner').get();
  const ownerTicked=owner?Number(Boolean(runtime.namedReference(owner,'bTicked').get()))===options?.level?.tickTag:true;
  const result=tickActor(actor,seconds,options);calls.push({actor,seconds,result,ownerTicked});return result;
};
const hudTick=game.hud.tick.bind(game.hud),hudDeltas=[];
game.hud.tick=dt=>{hudDeltas.push(dt);return hudTick(dt);};

// Binary-exact intervals isolate the integration from arithmetic already
// checked by the original ULevel.Tick oracle. Slow frames do not replay NPCs.
let elapsed=0;
for(const [seconds,scale,expected] of [[1/64,1,1/64],[1/8,1,1/8],[1,1,Math.fround(.4)],
  [1/1024,1,Math.fround(.005)],[1/8,.5,1/16]]) {
  dilation.set(scale);calls.length=0;hudDeltas.length=0;
  const steps=game.player.steps;
  game.tick(seconds,{});elapsed+=seconds*scale;
  assert.equal(game.player.steps,steps+1,'one player tick per host frame');
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
  assert.deepEqual(hudDeltas,[expected],'HUD shares the actor delta');
  assert.equal(level.timeSeconds(),elapsed,'double clock advances before the actor clamp');
  assert.equal(time.get(),Math.fround(elapsed),'scripts see the current level time');
}
game.reset();assert.equal(level.timeSeconds(),0);assert.equal(time.get(),0);
dilation.set(1);calls.length=0;
game.tick(1/64,{});
assert.ok(calls.length>0);assert.equal(game.player.steps,1);
assert.equal(level.timeSeconds(),1/64);
console.log('PASS Play frame timing: one NPC/player/HUD pass, shared clamped/dilated delta, unclamped double time, script time and reset.');
