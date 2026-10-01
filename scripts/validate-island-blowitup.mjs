/** DeusExMover.BlowItUp in Play: a breakable door (DeusExMover13) and a
 * pane of BreakableGlass (BreakableGlass0) on UNATCO Island destroyed through
 * their original TakeDamage. BlowItUp ends with SetLocation(Location +
 * vect(0,0,20000)), a FarMoveActor of a moving brush, which paused Oceanlab
 * and Vandenberg conversations with "FarMoveActor for a pawn, brush or
 * non-colliding map actor is not linked". Boots the map, damages each mover,
 * ticks the level, and checks that the original body ran to its end: the
 * mover sits 20000 units up with OldLocation equal to Location (FarMoveActor
 * zeroes its velocity that way), it no longer collides, bDestroyed is set,
 * its fragments spawned, and no runtime error occurred. The relocation and
 * the brush CheckEncroachment are proven against the original by
 * validate-native-mover-move.mjs. */
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
const step = () => { simulatedMs += 1000 / 60; game.tick(1 / 60); game.hud.commands(1440, 960, game.view()); };
for (let i = 0; i < 30; i++) step();

const player = game.player.collisionActor;
const results = [];
for (const name of ['DeusExMover13', 'BreakableGlass0']) {
  const mover = level.actors.find(actor => actor?.name === name);
  assert.ok(mover?.movingBrush, `${name} is a map mover`);
  const before = read(mover, 'Location').slice(), spawnedBefore = level.actors.length;
  let error = null;
  try {
    runtime.processEvent(mover, 'TakeDamage', [10000, player, before, [0, 0, 0], 'Exploded']);
    for (let i = 0; i < 10; i++) step();
  } catch (e) { error = String(e?.message ?? e).split('\n')[0]; }
  assert.equal(error, null, `${name}: no runtime error`);
  const after = read(mover, 'Location');
  assert.equal(read(mover, 'bDestroyed'), true, `${name}: bDestroyed`);
  assert.deepEqual(after, [before[0], before[1], Math.fround(before[2] + 20000)], `${name}: moved out of the way`);
  assert.deepEqual(read(mover, 'OldLocation'), after, `${name}: FarMoveActor wrote OldLocation`);
  assert.equal(read(mover, 'bCollideActors'), false, `${name}: no longer collides`);
  assert.deepEqual(mover.collider.offset, [0, 0, 20000], `${name}: renderer offset`);
  const fragments = level.actors.slice(spawnedBefore).filter(actor => actor && runtime.instance(actor).cls.record.key.includes('fragment')).length;
  assert.ok(fragments > 0, `${name}: fragments spawned`);
  results.push({ name, fragments, z: after[2] });
}
console.log(JSON.stringify({ ok: true, results }));
process.exit(0);
