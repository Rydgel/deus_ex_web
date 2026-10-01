/** A rotating mover in Play: UNATCO Island's DeusExMover10 (Tag temp_celldoor,
 * KeyRot[1] yaw 16384, Gunther's cell). Paused GuntherRescued with "MovingBrush
 * interpolation outside the recovered translating subset" before the general
 * AMover::physMovingBrush (docs/doors.md). Boots the map, checks the native
 * fields seeded from the mover's own storage, triggers it through its original
 * state code, ticks the whole level, and checks that the door turns a quarter
 * turn through MoveActor's NewRotation, that its collision registration
 * follows the turn, and that InterpolateEnd ends the interpolation. The body
 * itself is proven bit-exact by validate-native-mover-interpolation.mjs. */
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
const step = () => { simulatedMs += 1000 / 60; game.tick(1 / 60); game.hud.commands(1440, 960, game.view()); };
for (let i = 0; i < 30; i++) step();

const door = game.collision.movers.find(mover => mover.name === 'DeusExMover10');
assert.ok(door, 'DeusExMover10 is a map mover');
const state = door.interpolation;
assert.deepEqual(state.keyRotations[1], [0, 16384, 0], 'KeyRot[1] seeded from the mover storage');
assert.equal(state.keyRotations.length, 8, 'all eight KeyRot slots');
assert.deepEqual(read(door, 'KeyRot')[1], [0, 16384, 0], 'the script reads KeyRot[1]');
assert.equal(read(door, 'KeyNum'), 0);
assert.equal(read(door, 'bInterpolating'), false);
const start = read(door, 'Rotation').map(v => v | 0);

const events = [];
const processEvent = runtime.processEvent.bind(runtime);
runtime.processEvent = (receiver, name, ...rest) => {
  if (receiver === door) events.push(String(name));
  return processEvent(receiver, name, ...rest);
};
const player = game.player.collisionActor;
runtime.processEvent(door, 'Trigger', [player, player]);
const rotations = [];
let error = null, ticks = 0;
for (; ticks < 900; ticks++) {
  try { step(); } catch (e) { error = `${ticks}: ${String(e?.message ?? e).split('\n')[0]}`; break; }
  rotations.push(read(door, 'Rotation')[1] | 0);
  if (ticks > 10 && !read(door, 'bInterpolating') && read(door, 'KeyNum') === 1) break;
}
assert.equal(error, null, 'no runtime error while the door turns');
const yaws = [...new Set(rotations)];
assert.equal(read(door, 'KeyNum'), 1, 'the door reached key 1');
assert.equal(read(door, 'bInterpolating'), false, 'InterpolateEnd ended the interpolation');
assert.deepEqual(read(door, 'Rotation').map(v => v | 0), [start[0], (start[1] + 16384) | 0, start[2]], 'BaseRot + KeyRot[1]');
assert.ok(yaws.length > 10, 'the door turned over many frames');
for (let i = 1; i < yaws.length; i++) assert.ok(yaws[i] > yaws[i - 1], 'the yaw advances monotonically');
assert.ok(events.includes('InterpolateEnd'), 'the original InterpolateEnd event ran');
assert.deepEqual(door.position, read(door, 'BasePos'), 'a rotating key leaves Location at BasePos');
// The hash and brush queries take ABrush::ToWorld of the live pose.
assert.deepEqual(door.collisionValues.Rotation.map(v => v | 0), read(door, 'Rotation').map(v => v | 0), 'collision follows the turn');
console.log(JSON.stringify({ ok: true, ticks, frames: yaws.length, start, end: read(door, 'Rotation'), events: [...new Set(events)] }));
process.exit(0);
