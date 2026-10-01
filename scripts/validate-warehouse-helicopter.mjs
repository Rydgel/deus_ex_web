/** PHYS_Interpolating in Play: Warehouse's BlackHelicopter1 flown by its
 * original InterpolateTrigger0 (Tag CopterTrigger) along the CopterExit
 * InterpolationPoint path. Paused JockExit with "Non-Pawn performPhysics
 * PHYS_Interpolating (0x103dd8a0) is not linked" before AActor::physPathing
 * (docs/pathing.md). Boots the map, runs the trigger's original
 * SendActorOnPath, ticks the whole level, and checks that the helicopter
 * leaves under PHYS_Interpolating, that its Target steps through the path's
 * points in Position order with the original InterpolateEnd events on both
 * sides, that it moves and turns through MoveActor, that performPhysics
 * leaves Velocity = (Location - OldLocation)/dt, and that no runtime error
 * occurs. The body itself is proven bit-exact by validate-native-pathing.mjs. */
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
const assets = new AssetStore(files), asset = await assets.get('02_NYC_Warehouse');
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
const runtime = game.doors.scriptRuntime.runtime;
const read = (object, name) => runtime.readNamed(object, name);
const level = runtime.levelFor(game.player.collisionActor);
const step = () => { simulatedMs += 1000 / 60; game.tick(1 / 60); game.hud.commands(1440, 960, game.view()); };
for (let i = 0; i < 30; i++) step();

const byName = name => level.actors.find(actor => actor?.name === name);
const heli = byName('BlackHelicopter1'), trigger = byName('InterpolateTrigger0');
assert.ok(heli && trigger, 'the Warehouse helicopter and its InterpolateTrigger');
const start = read(heli, 'Location').slice();
const events = [];
const processEvent = runtime.processEvent.bind(runtime);
runtime.processEvent = (receiver, name, args, ...rest) => {
  if (String(name).toLowerCase() === 'interpolateend')
    events.push(`${receiver?.name}(${args?.[0]?.name ?? 'None'})`);
  return processEvent(receiver, name, args, ...rest);
};
const player = game.player.collisionActor;
runtime.processEvent(trigger, 'Trigger', [player, player]);
assert.equal(read(heli, 'Physics'), 8, 'SendActorOnPath set PHYS_Interpolating');
assert.equal(read(read(heli, 'Target'), 'Position'), 1, 'the path starts at Position 1');

const targets = [], yaws = new Set();
let error = null, ticks = 0, velocityChecked = 0;
for (; ticks < 1800 && read(heli, 'Physics') === 8; ticks++) {
  try { step(); } catch (e) { error = `${ticks}: ${String(e?.message ?? e).split('\n')[0]}`; break; }
  const target = read(heli, 'Target');
  const position = target ? read(target, 'Position') : null;
  if (targets.at(-1) !== position) targets.push(position);
  yaws.add(read(heli, 'Rotation')[1] | 0);
  if (read(heli, 'Physics') === 8) {
    const location = read(heli, 'Location'), old = read(heli, 'OldLocation'), velocity = read(heli, 'Velocity');
    // performPhysics: Velocity = (Location - OldLocation) * (1/dt), dt = 1/60.
    for (let axis = 0; axis < 3; axis++)
      assert.ok(Math.abs(velocity[axis] - (location[axis] - old[axis]) * 60) <= 1e-3 * Math.max(1, Math.abs(velocity[axis])), 'Velocity bracket');
    velocityChecked++;
  }
}
const end = read(heli, 'Location');
const travelled = Math.hypot(...end.map((v, i) => v - start[i]));
const summary = { ticks, physics: read(heli, 'Physics'), interpolating: read(heli, 'bInterpolating'), alpha: read(heli, 'PhysAlpha'),
  rate: read(heli, 'PhysRate'), targets, travelled: Math.round(travelled), yaws: yaws.size, velocityChecked,
  interpolateEnds: events.length, first: events.slice(0, 4), error };
if (process.env.VERBOSE) console.error(JSON.stringify(summary));
assert.equal(error, null, 'no runtime error while the helicopter flies');
assert.ok(targets.length > 3, 'Target stepped through several points');
for (let i = 1; i < targets.length; i++)
  assert.ok(targets[i] === null || targets[i - 1] === null || targets[i] > targets[i - 1] || targets[i] === 0, `Position order ${targets}`);
assert.ok(travelled > 256, 'the helicopter moved along its path');
assert.ok(yaws.size > 1, 'the helicopter turned along its path');
assert.ok(events.some(e => e.startsWith('BlackHelicopter1(')), 'the helicopter received InterpolateEnd');
assert.ok(events.some(e => e.startsWith('InterpolationPoint')), 'the points received InterpolateEnd');
// The bEndOfPath point's original InterpolateEnd stops a non-player and drops it to PHYS_Falling.
assert.equal(read(heli, 'Physics'), 2, 'InterpolationPoint.InterpolateEnd set PHYS_Falling at the end of the path');
assert.equal(read(heli, 'bInterpolating'), false);
console.log(JSON.stringify({ ok: true, ...summary }));
process.exit(0);
