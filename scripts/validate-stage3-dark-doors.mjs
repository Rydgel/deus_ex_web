/** Focused Play integration for Training's original darkdoor pair. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(path.join(root,directory)))
    files.push({path:`${directory}/${name}`,read:()=>readFile(path.join(root,directory,name))});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1});
const pair=game.collision.movers.filter(mover=>['DeusExMover19','DeusExMover20'].includes(mover.name));
assert.deepEqual(pair.map(mover=>mover.name),['DeusExMover19','DeusExMover20']);
assert.ok(pair.every(mover=>mover.supported&&mover.values.Tag==='darkdoor'&&mover.values.Event==='padoor'));
const level=game.doors.scriptRuntime.runtime.levelFor(pair[0]);
assert.deepEqual(level.actors.filter(actor=>String(actor?.values?.Tag??'').toLowerCase()==='padoor'),[],
  'complete original actor array has no padoor recipient');

const runtime=game.doors.scriptRuntime.runtime;
const createIterator=runtime.createIterator.bind(runtime);
const iterations=[];
runtime.createIterator=call=>{
  const iterator=createIterator(call),record={native:call.index,next:0,matches:0};iterations.push(record);
  return {next(){record.next++;const found=iterator.next();if(found)record.matches++;return found;}};
};
const tick=seconds=>{for(let frame=0;frame<Math.round(seconds*120);frame++)game.tick(1/120,{});};
const use=target=>{game.interaction.frobTarget=target;return game.use();};

const closedHit=game.collision.sweep([4240,848,-144],[100,0,0],game.player.extent);
assert.ok(pair.includes(closedHit?.actor),'closed pair blocks the player-sized route');
assert.deepEqual(use(pair[0]).actors,pair.map(mover=>mover.name));
tick(2.1);
assert.deepEqual(pair.map(mover=>mover.interpolation.key),[1,1]);
assert.deepEqual(pair.map(mover=>mover.collider.offset),[[0,-56,0],[0,56,0]]);
assert.deepEqual(iterations,[{native:304,next:3,matches:2},{native:304,next:1,matches:0},{native:304,next:1,matches:0}],
  'the frob runs original DeusExMover.Frob AllActors(class\'DeusExMover\',Tag) over both darkdoor panels, '+
  'then each panel executes original FinishedOpening AllActors(Event) with zero matches');
assert.equal(game.collision.sweep([4240,848,-144],[100,0,0],game.player.extent),null,
  'opened doorway clears the player-sized route');
assert.equal(game.player.nativeFarMove(game.player.physicsPawn,[4240,848,-144],0,1),true);
game.player.yaw=0;
for(let frame=0;frame<120;frame++)game.tick(1/120,{forward:1,yaw:0});
assert.ok(game.player.position[0]>4320,'player walks through the opened doorway');

const beforeClose=iterations.length;
assert.equal(use(pair[0]).ok,true);tick(2.1);
assert.deepEqual(pair.map(mover=>mover.interpolation.key),[0,0]);
assert.deepEqual(pair.map(mover=>mover.collider.offset),[[0,0,0],[0,0,0]]);
assert.deepEqual(iterations.slice(beforeClose),[{native:304,next:3,matches:2},{native:304,next:1,matches:0},{native:304,next:1,matches:0}],
  'closing repeats the original Frob Tag fanout, then each panel executes original DoClose AllActors(Event) with zero matches');

game.reset();
assert.deepEqual(pair.map(mover=>[mover.interpolation.key,mover.target,mover.collider.offset]),
  [[0,0,[0,0,0]],[0,0,[0,0,0]]]);
const originalPair=game.collision.movers.filter(mover=>['DeusExMover16','DeusExMover17'].includes(mover.name));
assert.ok(originalPair.every(mover=>mover.supported));
assert.equal(use(originalPair[0]).ok,true);tick(2.1);
assert.deepEqual(originalPair.map(mover=>mover.interpolation.key),[1,1],
  'existing starting-door pair still executes');
console.log('Stage 3 darkdoor milestone passed: original empty Event fanout, paired open/walk/close/reset, and starting doors preserved.');
