/** NPCs through a door that swings toward them: 03_NYC_UNATCOHQ's
 * DeusExMover10 (Tag Manderley_Office, TriggerToggle, KeyRot[1] yaw -16384,
 * an 80-unit leaf, MoverEncroachType ME_ReturnWhenEncroach).
 *
 * Two natives decided this door. (1) Mover.EncroachingOn calls MakeGroupReturn,
 * whose `GotoState( , 'Close' )` omits the state name; Core.dll execGotoState
 * (0x1013dd00) pre-seeds that slot with the current state's name, so the mover
 * stays in TriggerToggle (MakeGroupStop's `GotoState( , '' )` likewise). Play
 * read it as None and left the door stateless half open. (2) Engine
 * execGetBoundingBox (0x1036dea0) returns the FBox IsValid byte;
 * DeusExMover.ComputeMovementArea adds each swing pose's box only when it is
 * true. Play returned nothing, so the movement area was the closed leaf alone
 * (area.Y 6) and ScriptedPawn.OpeningDoor.FindBackupPoint backed the NPC up
 * 40 units, where the swing hit him again, forever.
 *
 * Part 1 drives the Mover bodies and ComputeMovementArea on the live door.
 * Part 2 makes the original Mission03.Timer call,
 * Simons.SetOrders('GoingTo','SimonsInterrogating',True), and follows him: the
 * first frob happens against the leaf (OpeningDoor.HitWall's CheckOpenDoor sets
 * Destination to the in-step Location, ending StrafeTo), the swing hits him and
 * returns, FinishNotify's StopWaiting sends him back, he backs out of the
 * movement area and the door opens clear of him; he then reaches his
 * SimonsInterrogating PatrolPoint. Headless, nothing is drawn, so Simons' own
 * LastRenderTime is stamped every tick to keep him out of stasis (a workload
 * approximation, not the original visibility test). */
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
const assets = new AssetStore(files), asset = await assets.get('03_NYC_UNATCOHQ');
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
const runtime = game.doors.scriptRuntime.runtime;
const read = (object, name) => runtime.readNamed(object, name);
const stateOf = object => runtime.instance(object).state?.stateNode?.record?.name ?? 'None';
const hasCode = object => Boolean(runtime.instance(object).state?.execution?.cursor != null);
const level = runtime.levelFor(game.player.collisionActor);
let simons = null;
for (let pawn = level.pawnList; pawn; pawn = pawn.nextPawn) if (pawn.name === 'WaltonSimons0') simons = pawn;
assert.ok(simons, 'WaltonSimons0 is in the pawn list');
const step = () => {
  simulatedMs += 1000 / 60;
  runtime.writeNamed(simons, 'LastRenderTime', read(level.actors[0], 'TimeSeconds'));
  game.tick(1 / 60);
};
for (let i = 0; i < 5; i++) step();

const door = game.collision.movers.find(mover => mover.name === 'DeusExMover10');
assert.ok(door, 'DeusExMover10 is a map mover');
assert.equal(read(door, 'Tag'), 'Manderley_Office');
assert.equal(read(door, 'MoverEncroachType'), 1, 'ME_ReturnWhenEncroach');
assert.deepEqual(read(door, 'KeyRot')[1], [0, -16384, 0]);
assert.equal(stateOf(door), 'TriggerToggle');
// The Play hint line reads the live script state for every map mover.
assert.equal(game.doors.describe(door).label, "It's locked", 'the locked, closed door says so');
for (const mover of game.collision.movers)
  assert.doesNotMatch(game.doors.describe(mover).label, /not supported/, `${mover.name} hint`);

// Part 1: the Mover bodies, on the live door.
const player = game.player.collisionActor;
const runUntil = (test, limit, label) => {
  for (let i = 0; i < limit; i++) { if (test()) return i; step(); }
  assert.fail(`${label} within ${limit} ticks`);
};
runtime.processEvent(door, 'Trigger', [player, player]);
runUntil(() => read(door, 'bInterpolating') && read(door, 'KeyNum') === 1, 5, 'Trigger opens');
step();
runtime.processEvent(door, 'MakeGroupReturn', []);
assert.equal(stateOf(door), 'TriggerToggle', "MakeGroupReturn's GotoState( , 'Close' ) keeps the state");
runUntil(() => read(door, 'KeyNum') === 0 && !read(door, 'bInterpolating'), 240, 'the returned door closes');
assert.deepEqual(read(door, 'Rotation').map(v => v | 0), [0, 0, 0], 'closed at key 0');
runtime.processEvent(door, 'Trigger', [player, player]);
runUntil(() => read(door, 'bInterpolating') && read(door, 'KeyNum') === 1, 5, 'Trigger opens again');
step();
runtime.processEvent(door, 'MakeGroupStop', []);
assert.equal(stateOf(door), 'TriggerToggle', "MakeGroupStop's GotoState( , '' ) keeps the state");
assert.equal(hasCode(door), false, 'no Begin label in TriggerToggle: no state code runs');
const stopped = read(door, 'Rotation').map(v => v | 0);
step(); step();
assert.deepEqual(read(door, 'Rotation').map(v => v | 0), stopped, 'a stopped door stays put');
runtime.processEvent(door, 'Trigger', [player, player]);
runUntil(() => read(door, 'KeyNum') === 0 && !read(door, 'bInterpolating'), 300, 'the stopped door answers Trigger and closes');
// The union of the closed box and the three swing poses' boxes
// (x -82..0, y 224..314, z 240..384), not the closed leaf alone.
const movement = [[0, 0, 0], [0, 0, 0]];
runtime.processEvent(door, 'ComputeMovementArea', movement);
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.01);
assert.ok(near(movement[0], [-41, 269, 312]) && near(movement[1], [41, 45, 72]),
  `ComputeMovementArea center ${movement[0]} area ${movement[1]}`);

// Part 2: Mission03.Timer's original call, and Simons at the door.
const events = [];
const processEvent = runtime.processEvent.bind(runtime);
runtime.processEvent = (receiver, name, args, ...rest) => {
  if (receiver === door && name === 'EncroachingOn') events.push({ tick: ticks, name });
  return processEvent(receiver, name, args, ...rest);
};
processEvent(simons, 'SetOrders', ['GoingTo', 'SimonsInterrogating', true]);
const trace = [];
let previous = '', error = null, ticks = 0;
const waiting = () => read(door, 'WaitingPawn')?.name ?? 'None';
const goal = level.actors.find(actor => actor && actor.lineage?.includes('engine.navigationpoint') && String(read(actor, 'Tag')) === 'SimonsInterrogating');
assert.ok(goal, 'the SimonsInterrogating point');
const distance = () => { const a = read(simons, 'Location'), b = read(goal, 'Location'); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); };
let passed = null;
for (; ticks < 7500; ticks++) {
  try { step(); } catch (e) { error = `${ticks}: ${String(e?.message ?? e).split('\n')[0]}`; break; }
  const sample = `${stateOf(simons)}|${stateOf(door)}|${read(door, 'KeyNum')}|${waiting()}`;
  if (sample !== previous) trace.push({ tick: ticks, simons: stateOf(simons), door: stateOf(door), key: read(door, 'KeyNum'), waiting: waiting() });
  previous = sample;
  // North of the leaf's hinge line (y 304) and out of its swing.
  if (passed === null && read(simons, 'Location')[1] > 330) passed = ticks;
  if (stateOf(simons) === 'Standing' && distance() < 64) break;
}
assert.equal(error, null, 'no runtime error');
assert.ok(trace.every(s => s.door === 'TriggerToggle'), 'the door never left TriggerToggle');
assert.ok(events.length > 0, 'the first swing reached Simons (EncroachingOn)');
const hit = events[0].tick;
assert.ok(trace.some(s => s.tick <= hit && s.waiting === 'WaltonSimons0'), 'FrobDoor made Simons the WaitingPawn');
// Mover.FinishNotify (FinishedClosing) calls WaitingPawn.StopWaiting and
// clears it; OpeningDoor.StopWaiting goes to DoorOpened.
const released = trace.find(s => s.tick > hit && s.key === 0 && s.waiting === 'None');
assert.ok(released, "the returned door's FinishNotify cleared WaitingPawn");
assert.equal(events.length, 1, 'backed out of the movement area, the second swing misses him');
assert.ok(passed !== null, 'Simons walked through the door');
assert.equal(stateOf(simons), 'Standing', 'GoingTo finished');
assert.ok(distance() < 64, `Simons reached SimonsInterrogating (${distance().toFixed(1)})`);
console.log(JSON.stringify({ ok: true, ticks, passed, encroachments: events.length, distance: Math.round(distance()), trace: trace.slice(0, 10) }));
process.exit(0);
