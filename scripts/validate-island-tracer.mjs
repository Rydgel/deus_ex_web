/** DeusEx.Tracer on Liberty Island through the live AActor::physProjectile
 * adapter (docs/projectile.md). The rounds terrorists and bots fire paused
 * Play with "physProjectile (0x103d4600) is not linked"; this spawns Tracers
 * with the original SpawnActor next to the player, ticks the whole level, and
 * checks that each one flies under PHYS_Projectile, that the one aimed at the
 * ground reaches HitWall through the original MoveActor, and that all of them
 * end destroyed without a runtime error. The body itself is proven bit-exact
 * by validate-native-projectile.mjs. */
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

const deusEx = await assets.get('DeusEx');
const tracerClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('tracer'));
const player = game.player.collisionActor;
const eye = read(player, 'Location').map((v, i) => v + (i === 2 ? 40 : 0));
const tracers = new Map();
const processEvent = runtime.processEvent.bind(runtime);
runtime.processEvent = (receiver, name, ...rest) => {
  tracers.get(receiver)?.events.push(name);
  return processEvent(receiver, name, ...rest);
};
let projectileCalls = 0;
const actorPhysics = runtime.actorPhysics;
runtime.actorPhysics = (actor, delta) => {
  if (tracers.has(actor) && read(actor, 'Physics') === 6) projectileCalls++;
  return actorPhysics(actor, delta);
};
// Straight down, along the player's view, and level to the side.
for (const [label, rotation] of [['down', [-16384, 0, 0]], ['view', read(player, 'Rotation').map(v => v | 0)], ['side', [-2000, 16384, 0]]]) {
  const tracer = runtime.spawnActor({ cls: tracerClass.record, level, name: 'None', owner: null, instigator: null, location: eye, rotation });
  assert.ok(tracer, `SpawnActor admitted a Tracer (${label})`);
  assert.equal(read(tracer, 'Physics'), 6, `${label}: the Tracer flies under PHYS_Projectile`);
  tracers.set(tracer, { label, events: [] });
}
let error = null, ticks = 0;
while (!error && ticks < 300 && [...tracers.keys()].some(t => !read(t, 'bDeleteMe'))) {
  ticks++;
  try { step(); } catch (e) { error = `${ticks}: ${String(e?.message ?? e).split('\n')[0]}`; }
}
assert.equal(error, null, 'no runtime error while the Tracers fly');
const summary = [...tracers].map(([tracer, { label, events }]) => ({ label, deleted: read(tracer, 'bDeleteMe'),
  hitWall: events.includes('HitWall'), destroyed: events.includes('Destroyed'), ticks: events.filter(e => e === 'Tick').length }));
for (const s of summary) assert.ok(s.deleted && s.destroyed, `${s.label}: the Tracer ends destroyed`);
assert.ok(summary.find(s => s.label === 'down').hitWall, 'the Tracer aimed at the ground reaches HitWall');
assert.ok(projectileCalls > 3, 'performPhysics ran physProjectile for the Tracers');
console.log(JSON.stringify({ ok: true, ticks, projectileCalls, tracers: summary }));
process.exit(0);
