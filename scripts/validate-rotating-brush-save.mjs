/** A spinning fan destroyed, saved and loaded, in Play only (docs/rotating-brushes.md "What Play had"): the round trip that retromaggedon's Save0021
 * (a third-party save kept outside Git) shows, with files Play wrote itself.
 *
 * 09_NYC_ShipFan: DeusExMover1 (the AC fan, RotationRate yaw -20000) is destroyed through its original TakeDamage -> DeusExMover.BlowItUp (SetLocation + 20000,
 * SetCollision(False,False,False), bDestroyed), keeps spinning, and `SaveGame 4` writes the level. `LoadGame 4` restores it in a new session. The restored
 * mover has no bCollideActors, so the level load used to drop it before it became a moving brush, and its first physicsRotation stopped with
 * "SetRotation MoveActor for a pawn, brush or non-colliding map actor is not linked". Checks, in the restored level:
 *   - the destroyed fan is where it was saved (Location z + 20000, bDestroyed, no collision), still a tracked mover, and not in the collision hash;
 *   - every tick turns it by _ftol(-20000 * dt) = -333 in Yaw, Pitch and Roll untouched (the saved 32768 / -32768), Location unchanged;
 *   - DeusExMover2 and 3 (stock, colliding) turn their pitch by -+500 per tick, as before the save;
 *   - nothing stops (no runtime error, no npcFailure) over 5 seconds, and the player is untouched.
 *
 *   node scripts/validate-rotating-brush-save.mjs */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import '../scripts/census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';

let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-rotating-brush-save: no installed game data'); process.exit(0); }
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
const picture = ({ pitch, height }) => Uint8Array.from({ length: pitch * height }, (_, i) => (i % pitch < 160 && (i / pitch | 0) < 120) ? ((i % pitch) * 3 + (i / pitch | 0)) & 255 : 0);
const consoleLine = (c, line) => c.game.hud.scoped(() => c.game.hud.host.consoleCommands.consoleCommand(c.player(), line));
const directory = createSaveDirectory({ freeSpaceBytes: 8 * 1024 ** 3 });

// ---- 1. the stock level: destroy the fan, let it spin on, save ------------------------------------------------------------------------------------
const { c } = await openSession('09_NYC_ShipFan', assets, { travel: { snapshotSource: picture }, saveDirectory: directory });
c.frames(60);
const fan = c.actor('DeusExMover1'), before = c.read(fan, 'Location').slice();
assert.equal(c.read(fan, 'bCollideActors'), true, 'the stock fan collides');
c.runtime.processEvent(fan, 'TakeDamage', [10000, c.player(), before, [0, 0, 0], 'Exploded']);
c.frames(10);
assert.equal(c.read(fan, 'bDestroyed'), true, 'BlowItUp ran');
assert.equal(c.read(fan, 'bCollideActors'), false, 'the destroyed fan no longer collides');
assert.deepEqual(c.read(fan, 'Location'), [before[0], before[1], Math.fround(before[2] + 20000)], 'moved 20000 up');
const spun = c.read(fan, 'Rotation').slice();
c.frames(30);
assert.notDeepEqual(c.read(fan, 'Rotation'), spun, 'the destroyed fan keeps spinning');
consoleLine(c, 'SaveGame 4'); c.frames(2);
assert.ok(directory.directories().includes('Save0004'), `SaveGame 4 made ${directory.directories()}`);
consoleLine(c, 'LoadGame 4'); c.frames(2);
const request = c.takeTravel();
assert.ok(request?.restore, `LoadGame 4 made no restore request: ${request?.url}`);

// ---- 2. the restored level ----------------------------------------------------------------------------------------------------------------------
const { c: d } = await openSession(request.map, assets, { travel: { arrival: request, lastURL: request.lastURL, snapshotSource: picture }, saveDirectory: directory });
const restored = d.actor('DeusExMover1'), stock2 = d.actor('DeusExMover2'), stock3 = d.actor('DeusExMover3');
assert.equal(d.read(restored, 'bDestroyed'), true, 'the restored fan is destroyed');
assert.equal(d.read(restored, 'bCollideActors'), false, 'the restored fan does not collide');
assert.equal(d.read(restored, 'Location')[2], Math.fround(before[2] + 20000), 'the restored fan is 20000 up');
assert.ok(restored.movingBrush && d.game.collision.movers.includes(restored), 'the restored fan is a tracked moving brush');
assert.equal(d.read(stock2, 'bCollideActors'), true, 'DeusExMover2 collides');
const health = d.read(d.player(), 'Health'), location = d.read(restored, 'Location').slice();
const turns = [], samples = [];
let last = ['DeusExMover1', 'DeusExMover2', 'DeusExMover3'].map(name => d.read(d.actor(name), 'Rotation').slice());
for (let tick = 0; tick < 300; tick++) {
  d.frames(1);
  const now = ['DeusExMover1', 'DeusExMover2', 'DeusExMover3'].map(name => d.read(d.actor(name), 'Rotation').slice());
  samples.push(now.map((rotation, i) => rotation.map((v, axis) => ((v - last[i][axis]) << 16) >> 16)));   // signed 16-bit turn of each axis this tick
  last = now;
}
const expectTick = (fanIndex, axis, want) => samples.forEach((tick, n) => assert.equal(tick[fanIndex][axis], want, `tick ${n}: fan ${fanIndex + 1} axis ${axis} turned ${tick[fanIndex][axis]}, not ${want}`));
expectTick(0, 1, -333);                     // _ftol(-20000 / 60): the yaw of the destroyed fan
for (const axis of [0, 2]) expectTick(0, axis, 0);
expectTick(1, 0, -500); expectTick(2, 0, 500);   // the stock pitch fans, +-30000 / 60
assert.deepEqual(d.read(restored, 'Location'), location, 'the destroyed fan stays where it was saved');
assert.equal(d.read(d.player(), 'Health'), health, 'the player is untouched');
assert.equal(d.game.doors.scriptRuntime.npcFailures.size, 0, 'no failure swallowed by the tick');
console.log(`PASS validate-rotating-brush-save: DeusExMover1 destroyed, saved (Save0004) and restored non-colliding at z ${location[2]}; 300 ticks: yaw -333 each, pitch fans -+500, Location fixed`);
process.exit(0);
