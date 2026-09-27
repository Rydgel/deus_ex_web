/** Focused Play integration for Training's original darkdoor pair. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(path.join(root,directory)))
    files.push({path:`${directory}/${name}`,read:()=>readFile(path.join(root,directory,name))});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1});
const input=createPlayerInputFixture(game,{tickSeconds:1/120});
const pair=game.collision.movers.filter(mover=>['DeusExMover19','DeusExMover20'].includes(mover.name));
assert.deepEqual(pair.map(mover=>mover.name),['DeusExMover19','DeusExMover20']);
assert.ok(pair.every(mover=>mover.supported&&mover.values.Tag==='darkdoor'&&mover.values.Event==='padoor'));
const level=game.doors.scriptRuntime.runtime.levelFor(pair[0]);
assert.deepEqual(level.actors.filter(actor=>String(actor?.values?.Tag??'').toLowerCase()==='padoor'),[],
  'complete original actor array has no padoor recipient');

const runtime=game.doors.scriptRuntime.runtime;
assert.ok(runtime.classLoader,'Play uses the recovered class loader');
const moverClass=await runtime.classes.get('deusex.deusexmover');
assert.equal(moverClass.defaultsSource,'original-linker-serialized');
assert.equal(runtime.classLoader.identity(moverClass.loadRecord),moverClass.record,
  'the live mover class retains the native loader canonical identity');
const createIterator=runtime.createIterator.bind(runtime);
const iterations=[];
runtime.createIterator=call=>{
  const iterator=createIterator(call);
  // Live NPC perception ticks issue their own CycleActors/AllActors scans; the
  // sequence this check asserts belongs to the two door panels' own bodies.
  if(!pair.includes(call.receiver))return iterator;
  const record={native:call.index,next:0,matches:0};iterations.push(record);
  return {next(){record.next++;const found=iterator.next();if(found)record.matches++;return found;}};
};
const tick=seconds=>input.tick(Math.round(seconds*120));
const use=async target=>{input.aim(target);return game.use();};

const closedHit=game.collision.sweep([4240,848,-144],[100,0,0],game.player.extent);
assert.ok(pair.includes(closedHit?.actor),'closed pair blocks the player-sized route');
assert.equal((await use(pair[0])).ok,true,'right click runs ParseRightClick -> DoFrob -> DeusExMover.Frob');
tick(2.1);
assert.deepEqual(pair.map(mover=>mover.interpolation.key),[1,1]);
assert.deepEqual(pair.map(mover=>mover.collider.offset),[[0,-56,0],[0,56,0]]);
assert.deepEqual(iterations,[{native:304,next:3,matches:2},{native:304,next:1,matches:0},{native:304,next:1,matches:0}],
  'the frob runs original DeusExMover.Frob AllActors(class\'DeusExMover\',Tag) over both darkdoor panels, '+
  'then each panel executes original FinishedOpening AllActors(Event) with zero matches');
assert.equal(game.collision.sweep([4240,848,-144],[100,0,0],game.player.extent),null,
  'opened doorway clears the player-sized route');
input.place([4240,848,-144],{yaw:0});input.driveLegacy({forward:1});
for(let frame=0;frame<120;frame++)input.tick(1);
input.driveLegacy({forward:0});
assert.ok(game.player.position[0]>4320,'player walks through the opened doorway');

const beforeClose=iterations.length;
// Opened, each panel's Location is inside its wall pocket; only its north edge
// (Y 784-792) faces the doorway. Stand in the doorway and aim at that edge;
// HighlightCenterObject's trace still has to select the panel.
input.aim(pair[0],{position:[4328,836,-144],point:[4328,790,-128]});
assert.equal(game.use().ok,true);tick(2.1);
assert.deepEqual(pair.map(mover=>mover.interpolation.key),[0,0]);
assert.deepEqual(pair.map(mover=>mover.collider.offset),[[0,0,0],[0,0,0]]);
assert.deepEqual(iterations.slice(beforeClose),[{native:304,next:3,matches:2},{native:304,next:1,matches:0},{native:304,next:1,matches:0}],
  'closing repeats the original Frob Tag fanout, then each panel executes original DoClose AllActors(Event) with zero matches');

game.reset();
assert.deepEqual(pair.map(mover=>[mover.interpolation.key,mover.target,mover.collider.offset]),
  [[0,0,[0,0,0]],[0,0,[0,0,0]]]);
const originalPair=game.collision.movers.filter(mover=>['DeusExMover16','DeusExMover17'].includes(mover.name));
assert.ok(originalPair.every(mover=>mover.supported));
assert.equal((await use(originalPair[0])).ok,true);tick(2.1);
assert.deepEqual(originalPair.map(mover=>mover.interpolation.key),[1,1],
  'existing starting-door pair still executes');
console.log('Stage 3 darkdoor milestone passed: original empty Event fanout, paired open/walk/close/reset, and starting doors preserved.');
