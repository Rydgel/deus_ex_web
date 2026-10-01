/** ULevel::CleanupDestroyed in Play (docs/script-cleanup.md): once 128
 * destroyed actors wait on the Deleted chain, Level.Tick's cleanup clears every
 * reference to a pending-kill actor (UStruct::CleanupDestroyed over each live
 * actor class) and releases the chain. 09_NYC_Dockyard's conversations paused
 * there with "CleanupDestroyed requires native reference validity and
 * pending-kill services". On a booted Island this spawns 130 Tracers, points a
 * pre-placed actor's Target at one of them, destroys them and a pre-placed
 * crate, ticks once, and checks: the chain is empty, the Target reference was
 * cleared, each spawned Tracer was released and its registry slot freed, the
 * crate's storage stayed with the level (it is out of the actor array but its
 * export restores on reset), and no runtime error occurred. */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

let simulatedMs = 0;
const RealDate = Date, epoch = new RealDate(2001, 5, 23, 12, 0, 0).getTime();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(epoch + simulatedMs); }
  static now() { return epoch + simulatedMs; }
};
Object.defineProperty(performance, 'now', { value: () => simulatedMs, configurable: true });

const { AssetStore } = await import('../src/unreal/assets.mjs');
const { decodeMap } = await import('../src/unreal/map.mjs');
const { createGame } = await import('../src/viewer/game.mjs');
const { gameDirectory } = await import('./game-directory.mjs');

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files), asset = await assets.get('01_NYC_UNATCOIsland');
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
const runtime = game.doors.scriptRuntime.runtime;
const read = (object, name) => runtime.readNamed(object, name);
const level = runtime.levelFor(game.player.collisionActor);
const registry = runtime.actorLifecycle.construction.registry;
const step = () => { simulatedMs += 1000 / 60; game.tick(1 / 60); game.hud.commands(1440, 960, game.view()); };
for (let i = 0; i < 30; i++) step();

const deusEx = await assets.get('DeusEx');
const tracerClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('tracer'));
const player = game.player.collisionActor;
const origin = read(player, 'Location').map((v, i) => v + (i === 2 ? 400 : 0));
const tracers = [];
for (let i = 0; i < 130; i++) {
  const tracer = runtime.spawnActor({ cls: tracerClass.record, level, name: 'None', owner: null, instigator: null,
    location: origin.map((v, axis) => v + (axis === 0 ? i * 4 : 0)), rotation: [16384, 0, 0] });
  assert.ok(tracer, 'SpawnActor admitted a Tracer');
  tracers.push({ tracer, record: runtime.instance(tracer).nativeObject });
}
const holder = level.actors.find(actor => actor?.name === 'CrateBreakableMedGeneral1');
const crate = level.actors.find(actor => actor?.name === 'CrateBreakableMedGeneral0');
assert.ok(holder && crate, 'the Island crates');
runtime.writeNamed(holder, 'Target', tracers[7].tracer);
for (const { tracer } of tracers) runtime.destroyActor(tracer);
runtime.destroyActor(crate);
let pending = 0;
for (let actor = level.pendingDeleted; actor; actor = read(actor, 'Deleted')) pending++;
assert.ok(pending >= 128, `the Deleted chain reaches the cleanup threshold (${pending})`);
const freeBefore = registry.freeIndices.length;
let error = null;
try { step(); } catch (e) { error = String(e?.message ?? e).split('\n')[0]; }
assert.equal(error, null, 'no runtime error in the cleanup tick');
assert.equal(level.pendingDeleted, null, 'the Deleted chain was released');
assert.equal(read(holder, 'Target'), null, 'the reference to a pending-kill actor was cleared');
for (const { record } of tracers) {
  assert.equal(record.released, true, 'each spawned Tracer was released');
  assert.equal(registry.objects[record.index], null, 'its registry slot was freed');
}
assert.ok(registry.freeIndices.length >= freeBefore + tracers.length, 'the freed slots joined the free list');
assert.ok(!level.actors.includes(crate), 'the destroyed crate left the actor array');
assert.equal(runtime.isReleased(crate), false, 'the pre-placed crate keeps its storage for the level reload');
console.log(JSON.stringify({ ok: true, pending, freed: registry.freeIndices.length - freeBefore }));
process.exit(0);
