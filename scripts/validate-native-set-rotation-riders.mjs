import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {playerMove} from '../src/runtime/player-move.mjs';
import {moveActorRiders} from '../src/runtime/move-riders.mjs';
import {setScriptRotation} from '../src/runtime/script-set-rotation.mjs';

// One original PlayerPawn with one noncolliding, inventory-like actor based on
// it.  The cases isolate changed zero-delta rotation with no yaw change (the
// signed-pitch wrap observed in live UpdateRotation) and an ordinary +90° yaw.
const scene = JSON.parse(await readFile('reports/movement/mover-move/scene.json', 'utf8'));
scene.actors = scene.actors.filter(actor => actor.kind === 'Mover');
scene.actors.push(
  {id: '$player', kind: 'Pawn', collisionBits: 15, values: {
    Location: [-300, 800, -64], Rotation: [0, 0, 0], CollisionRadius: 17, CollisionHeight: 42,
  }},
  {id: '$rider', kind: 'Actor', collisionBits: 0, owner: '$player', values: {
    Location: [-280, 800, -64], Rotation: [0, 100, 0], CollisionRadius: 0, CollisionHeight: 0,
  }},
);
const cases = [
  {name: 'pitch-int-wrap-same-yaw', playerLocation: [-300, 800, -64],
    oldRotation: [-7777, -16384, 0], newRotation: [57759, -16384, 0],
    riderLocation: [-280, 800, -64], riderRotation: [0, 100, 0]},
  {name: 'ordinary-yaw-plus-quarter-turn', playerLocation: [-300, 800, -64],
    oldRotation: [0, 0, 0], newRotation: [0, 16384, 0],
    riderLocation: [-280, 800, -64], riderRotation: [0, 100, 0]},
];
const dir = path.resolve('reports/movement/set-rotation-riders');
await mkdir(dir, {recursive: true});
const sceneFile = path.join(dir, 'scene.json'), caseFile = path.join(dir, 'cases.json');
await writeFile(sceneFile, JSON.stringify(scene));
await writeFile(caseFile, JSON.stringify(cases));
const {stdout} = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  ['scripts/native-set-rotation-riders-oracle.py', gameDirectory(), sceneFile, caseFile],
  {maxBuffer: 16 * 1024 * 1024, timeout: 120000});
const native = JSON.parse(stdout);
await writeFile(path.join(dir, 'original.json'), JSON.stringify(native, null, 2));
const [pitchWrap, yaw] = native.results;
assert.equal(pitchWrap.success, true);
assert.deepEqual(pitchWrap.playerRotation, [57759, -16384, 0]);
assert.deepEqual(pitchWrap.playerLocation, [-300, 800, -64]);
assert.deepEqual(pitchWrap.riderMoveCalls, [{actor: '$rider', delta: [0, 0, 0],
  rotation: [0, 100, 0], flags: [0, 0, 1, 0]}]);
assert.deepEqual(pitchWrap.events.map(event => event.hash ?? `zone:${event.zone}`),
  ['remove', 'add', 'zone:$player']);
assert.equal(yaw.success, true);
assert.deepEqual(yaw.riderLocation, [-300, 820, -64]);
assert.deepEqual(yaw.riderRotation, [0, 16484, 0]);
assert.deepEqual(yaw.riderMoveCalls, [{actor: '$rider', delta: [-20, 20, 0],
  rotation: [0, 16484, 0], flags: [0, 0, 1, 0]}]);
assert.deepEqual(yaw.events.map(event => event.hash ?? `zone:${event.zone}`),
  ['zone:$rider', 'remove', 'add', 'zone:$player']);
const translated = [];
for (const c of cases) {
  const source = {id: '$player', position: [...c.playerLocation], rotation: [...c.oldRotation],
    flags: 15, radius: 17, height: 42, pawn: true, standingCount: 1,
    static: false, movable: true, base: null, touching: [null, null, null, null]};
  const rider = {id: '$rider', position: [...c.riderLocation], rotation: [...c.riderRotation],
    flags: 0, radius: 0, height: 0, pawn: false, scriptView: true, standingCount: 0,
    static: false, movable: true, base: source, touching: [null, null, null, null]};
  const actors = [source, rider], worldActor = {id: '$world'};
  const events = [];
  const services = {
    worldActor, multiLineCheck: () => [],
    removeActor: actor => events.push({hash: 'remove', actor: actor.id, position: [...source.position]}),
    addActor: actor => events.push({hash: 'add', actor: actor.id, position: [...source.position]}),
    dispatch: () => { throw new Error('Unexpected script event in these zero-delta cases'); },
    isBlockedBy: () => { throw new Error('Unexpected BlockActors query in these cases'); },
    isOverlapping: () => { throw new Error('Unexpected touch overlap query in these cases'); },
    beginTouch: () => { throw new Error('Unexpected BeginTouch in these cases'); },
    endTouch: () => { throw new Error('Unexpected EndTouch in these cases'); },
    setActorZone: (actor, test, force) => events.push({zone: actor.id, test: Number(test),
      force: Number(force), position: [...source.position]}),
    moveRiders: (base, finalDelta, rotation) => moveActorRiders(base, finalDelta, rotation, {
      actors, baseOf: other => other.base,
      location: other => [...other.position], rotation: other => [...other.rotation],
      isPawn: other => other.pawn,
      addViewRotationYaw: (other, amount) => { other.viewRotationYaw = (other.viewRotationYaw + amount) | 0; },
      moveActor: (other, delta, newRotation) => playerMove(other, delta, services, newRotation).success,
      actorLocation: () => [...base.position], actorRotation: () => [...base.rotation],
    }),
  };
  const level = {editor: false, moveActor: (actor, delta, rotation, hit, ...flags) => {
    assert.equal(actor, source);
    assert.deepEqual(delta, [0, 0, 0]);
    assert.deepEqual(rotation, c.newRotation);
    assert.deepEqual(hit, [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, -1]);
    assert.deepEqual(flags, [0, 0, 0, 0]);
    return playerMove(actor, delta, services, rotation).success;
  }};
  const result = setScriptRotation(source, c.newRotation, {levelFor: () => level,
    read: (actor, field) => ({Rotation: actor.rotation, StandingCount: actor.standingCount,
      Brush: null, bStatic: actor.static, bMovable: actor.movable})[field],
    write: (actor, field, value) => { if (field === 'Rotation') actor.rotation = [...value]; }});
  const expected = native.results[cases.indexOf(c)];
  assert.equal(result, expected.success, `${c.name}: SetRotation result`);
  assert.deepEqual(source.position, expected.playerLocation, `${c.name}: source position`);
  assert.deepEqual(source.rotation, expected.playerRotation, `${c.name}: source rotation`);
  assert.deepEqual(rider.position, expected.riderLocation, `${c.name}: rider position`);
  assert.deepEqual(rider.rotation, expected.riderRotation, `${c.name}: rider rotation`);
  assert.deepEqual(events, expected.events, `${c.name}: move/hash/zone order`);
  translated.push({name: c.name, result, playerLocation: source.position,
    playerRotation: source.rotation, riderLocation: rider.position,
    riderRotation: rider.rotation, events});
}
await writeFile(path.join(dir, 'translation-comparison.json'), JSON.stringify({
  cases: translated, mismatches: [], scope: 'setScriptRotation -> live-level MoveActor -> playerMove/moveActorRiders',
}, null, 2));
console.log('Production SetRotation/playerMove/moveActorRiders matches both original zero-Delta rider records.');
console.log(JSON.stringify({cases: cases.map((c, i) => ({name: c.name, result: native.results[i]})), hashes: native.hashes}, null, 2));
