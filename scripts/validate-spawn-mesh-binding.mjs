/** A mesh actor spawned in a tick takes part in the next frame of the actor
 * mesh layer's simulation side (docs/npc-mesh-preview.md "A spawned actor's
 * first frame"): the original's DrawActorSprite draws and stamps it in the
 * render after that tick (0x10b25150; Stage 5 captures cmb5 and die1).
 *
 * On 01_NYC_UNATCOIsland booted through Play's createGame, each CarcassType
 * class the map's pawns and the player name is spawned between two updates
 * of createActorMeshSim, once with its default Mesh and once with Mesh2 (the
 * mesh DeusExCarcass.InitFor sets after DeathFront). Its binding must be made
 * inside the next update, before that frame's dynamics (the `occlude` hook
 * receives it), so it is never left to the asynchronous path
 * (summary.late), and Mesh, Mesh2 and Mesh3 must be prepared at load (the
 * spawn closure). This checks Play's residency and timing, not the original:
 * the stamp itself is compared by validate-stage5-live.mjs. */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { createActorMeshSim } from '../src/viewer/actor-mesh-sim.mjs';

const map = '01_NYC_UNATCOIsland', root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({ path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`) });
const assets = new AssetStore(files), asset = await assets.get(map);
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
const runtime = game.doors.scriptRuntime.runtime, player = () => game.player.collisionActor;
const sim = await createActorMeshSim(runtime, assets, asset, { player });
sim.update({});
const level = runtime.levelFor(player()), read = (actor, name) => runtime.readNamed(actor, name);
const defaultOf = (cls, name) => { const field = runtime.lookupMember(cls, 'fields', name); return field ? runtime.defaultValue(cls, field) : null; };
const carcasses = new Map();
for (const actor of [...level.actors, player()]) {
  if (!actor) continue;
  let ref;
  try { ref = read(actor, 'CarcassType'); } catch { continue; }
  if (ref?.linkedClass && !carcasses.has(ref.key)) carcasses.set(ref.key, { ref, from: actor });
}
assert.ok(carcasses.size >= 9, `${map}: ${carcasses.size} CarcassType classes`);
let spawned = 0;
for (const [key, { ref, from }] of carcasses) {
  const cls = ref.linkedClass;
  for (const name of ['Mesh', 'Mesh2', 'Mesh3']) {
    const mesh = defaultOf(cls, name);
    assert.ok(mesh, `${key}: ${name}`);
    assert.doesNotThrow(() => runtime.meshResource(mesh), `${key}: ${name} ${mesh.key} prepared at load`);
  }
  for (const name of ['Mesh', 'Mesh2']) {
    const actor = runtime.spawnActor({ cls: ref, level, name: 'None', owner: null, instigator: null,
      location: read(from, 'Location').slice(), rotation: read(from, 'Rotation').slice(), noCollisionFail: true });
    assert.ok(actor, `${key}: spawned`);
    runtime.writeNamed(actor, 'Mesh', defaultOf(cls, name));
    let candidate = false;
    sim.update({ occlude: args => { candidate = args.bindings.some(b => b.actor === actor) && args.levelIndex.has(actor); return { main: null, children: false }; } });
    assert.ok(candidate, `${key} with ${name}: bound before the dynamics of its first frame`);
    runtime.destroyActor(actor);
    sim.update({});
    spawned++;
  }
}
assert.deepEqual(sim.summary.late, [], 'no admission took the asynchronous path');
assert.deepEqual(sim.summary.errors, [], 'no binding failed');
sim.dispose();
console.log(`spawn mesh binding: ${spawned} carcasses of ${carcasses.size} classes bound in their first frame on ${map}; Mesh, Mesh2, Mesh3 prepared at load`);
