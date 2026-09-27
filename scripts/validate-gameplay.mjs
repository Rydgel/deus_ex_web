import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { readFunction } from '../src/unreal/script.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music']) for (const name of await readdir(path.join(root, dir))) files.push({ path: `${dir}/${name}`, read: () => readFile(path.join(root, dir, name)) });
const assets = new AssetStore(files), engine = await assets.get('Engine');
const checkBob = readFunction(engine, engine.exportsByPath.get('playerpawn.checkbob'));
const report = { checkBob: { function: checkBob.entry.path, expandedBytes: checkBob.size, serializedBytes: checkBob.bytes.length,
  sha256: createHash('sha256').update(checkBob.bytes).digest('hex') }, maps: [] };
const run = (game, seconds, input = {}) => { for (let i = 0; i < Math.round(seconds * 120); i++) game.tick(1 / 120, input); };
for (const name of ['00_Training', '01_NYC_UNATCOIsland']) {
  const asset = await assets.get(name), map = decodeMap(asset.bytes), game = await createGame(map, asset, assets);
  run(game, 1); const initial = game.player.status(); assert.equal(initial.grounded, true, `${name} lands at spawn`);
  assert.equal(game.collision.overlaps(initial.position, game.player.extent), false);
  const result = { name, initial, hulls: game.collision.bsp.hulls.length,
    blockingActors: game.collision.actors.filter(actor => actor.blocking).length };
  if (name === '00_Training') {
    assert.ok(Math.abs(initial.position[2] - -80.19999694824219) < 1e-4, 'standing height matches original saved pawn');
    run(game,.5,{crouch:true});
    assert.equal(game.player.height,16);assert.equal(game.player.forceDuck,false,'original upward ceiling trace is clear at spawn');
    run(game,1);
    assert.equal(game.player.height,43);assert.deepEqual(game.player.position,initial.position,'source stance sequence returns to the standing floor band');
    const bob = [];
    for (let i = 0; i < 240; i++) { game.tick(1 / 120, { forward: 1 }); bob.push([...game.player.walkBob]); }
    assert.ok(Math.max(...bob.map(v => v[2])) > 5 && Math.min(...bob.map(v => v[2])) < -5, 'original CheckBob executes during movement');
    // The closed face is at X -220. Radius 20 plus native MoveActor/LineCheck
    // margins stop the pawn about 2.2 units short of its geometric contact.
    run(game, 3, { forward: 1 }); assert.ok(game.player.position[0] < -242 && game.player.position[0] > -242.5);
    const cachedTarget=game.interaction.frobTarget;
    assert.equal(cachedTarget.name,'DeusExMover16');
    assert.equal(game.target().mover,cachedTarget,'UI uses the cached original target');
    const used = game.use(); assert.equal(used.ok, true);
    run(game, 2.1);
    for (const name of ['DeusExMover16', 'DeusExMover17'])
      assert.equal(game.collision.movers.find(m => m.name === name).interpolation.key, 1, `ParseRightClick's DoFrob opened ${name}`); assert.ok(game.player.walkBob.every(v => Math.abs(v) < .001));
    run(game, 1.5, { forward: 1 }); assert.ok(game.player.position[0] > 0); assert.ok(game.player.position[2] < initial.position[2] - 40);
    result.lowerHall=game.player.status();
    for(let i=0;i<360;i++){
      const before=game.player.status();game.tick(1/120,{forward:-1});
      if(!result.stairApproach&&game.player.position[2]>before.position[2]+1)result.stairApproach=before;
    }
    assert.ok(game.player.position[0] < -300);
    assert.ok(game.player.position[2] >= -80.4 && game.player.position[2] <= -79.9, 'floor probe remains within native 1.9–2.4 clearance band');
    result.route = game.player.status(); result.interaction = used; result.doors = game.doors.status();
    // Controlled placement isolates closing-door contact from camera targeting,
    // which is checked above through the original cached target. Native composed
    // mover-scene cases independently verify the displacement/query algorithm.
    const panel=game.collision.movers.find(m=>m.name==='DeusExMover16');
    assert.equal(game.player.nativeFarMove(game.player.physicsPawn,[-220,810,-80.2],0,1),true);
    game.player.velocity=[0,0,0];
    const contactStart=game.player.position.slice();
    const closing=game.doors.use(game.doors.describe(panel),game.player.position);
    assert.equal(closing.ok,true);run(game,2.2);
    assert.notDeepEqual(game.player.position,contactStart,'closing panel displaces the player through native movement');
    assert.ok(game.player.position.every(Number.isFinite));
    for(const door of game.collision.movers.filter(m=>m.values.Tag==='UN_maindoor')){
      assert.equal(door.interpolation.key,0);assert.equal(door.active,false);
      assert.deepEqual(door.collider.offset,[0,0,0]);
    }
    result.closingContact={start:contactStart,end:game.player.position.slice()};
    game.reset(); run(game, 1); assert.deepEqual(game.player.position, initial.position); assert.equal(game.doors.uses, 0);
  } else {
    run(game, 1, { forward: 1, yaw: (game.start.values.Rotation?.[1] ?? 0) * Math.PI / 32768 });
    assert.notDeepEqual(game.player.position, initial.position); assert.equal(game.collision.overlaps(game.player.position, game.player.extent), false);
    result.walked = game.player.status();
  }
  report.maps.push(result);
}
console.log(JSON.stringify(report, null, 2));
