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
  // Exact actor transforms and collision dimensions from the route's
  // pre-MoveActor snapshot in .cache/batch6-route-report8.json. The native
  // comparison uses one based rider (StandingCount=1); the captured 255 Play
  // value is preserved in route diagnostics but is not treated as original state.
  {id: '$crate', kind: 'Actor', collisionBits: 13, values: {
    Location: [1022.1097412109375, -275.102783203125, -103.89986419677734],
    Rotation: [0, 0, 0], CollisionRadius: 34, CollisionHeight: 23.25,
  }},
  {id: '$crate-rider', kind: 'Actor', collisionBits: 13, owner: '$crate', values: {
    Location: [1022.5962524414062, -278.5773010253906, -55.393245697021484],
    Rotation: [0, 1948, 0], CollisionRadius: 34, CollisionHeight: 23.25,
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
const crateCase = {name: 'training-stacked-crate-captured-rotation', source: '$crate', rider: '$crate-rider',
  sourceBase: '$world', playerLocation: [1022.1097412109375, -275.102783203125, -103.89986419677734],
  oldRotation: [0, 0, 0], newRotation: [0, -30, 0], standingCount: 1,
  riderLocation: [1022.5962524414062, -278.5773010253906, -55.393245697021484],
  riderRotation: [0, 1948, 0], riderStandingCount: 0};
// A changed rotation with riders and a nonzero Delta under 0.0001 on every axis (a rider's RotMotion for a pawn that turns a hair, the Metro's special guards): not the
// short return of 0x103991c8 (that needs an unchanged rotation or no riders), so the rider pass and the commit run with that Delta.
const tinyCase = {name: 'tiny-nonzero-delta-changed-rotation-with-rider', playerLocation: [-300, 800, -64],
  oldRotation: [0, 0, 0], newRotation: [0, 4, 0], standingCount: 1, delta: [0.00005, -0.00003, 0],
  riderLocation: [-299.953125, 800, -64], riderRotation: [0, 100, 0]};
const nativeCases = [...cases, crateCase, tinyCase];
const dir = path.resolve('reports/movement/set-rotation-riders');
await mkdir(dir, {recursive: true});
const sceneFile = path.join(dir, 'scene.json'), caseFile = path.join(dir, 'cases.json');
await writeFile(sceneFile, JSON.stringify(scene));
await writeFile(caseFile, JSON.stringify(nativeCases));
const {stdout} = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-set-rotation-riders-oracle.py', gameDirectory(), sceneFile, caseFile],
  {maxBuffer: 16 * 1024 * 1024, timeout: 120000});
const native = JSON.parse(stdout);
await writeFile(path.join(dir, 'original.json'), JSON.stringify(native, null, 2));
const [pitchWrap, yaw, crate] = native.results;
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
assert.equal(crate.success, true);
assert.deepEqual(crate.sourceLocation, crateCase.playerLocation);
assert.deepEqual(crate.sourceRotation, crateCase.newRotation);
assert.deepEqual(crate.riderLocation, [1022.5855712890625, -278.57876586914062, -55.393245697021484]);
assert.deepEqual(crate.riderRotation, [0, 1918, 0]);
assert.deepEqual(crate.riderMoveCalls, [{actor: '$crate-rider',
  delta: [-0.010661959648132324, -0.001476287841796875, 0],
  rotation: [0, 1918, 0], flags: [0, 0, 1, 0]}]);
assert.deepEqual(crate.checkEncroachment, [
  {source: '$crate-rider', position: crate.riderLocation, rotation: crate.riderRotation, notify: 0, rejected: false},
  {source: '$crate', position: crateCase.playerLocation, rotation: crateCase.newRotation, notify: 0, rejected: false},
]);
assert.deepEqual(crate.checkEncroachmentDispatches.map(call => call.target), [0x1039a350, 0x1039a350]);
assert.equal(crate.time, 1);
assert.equal(crate.hitActor, null);
assert.deepEqual(crate.events.map(event => event.hash ?? `zone:${event.zone}`),
  ['remove', 'add', 'zone:$crate-rider', 'remove', 'add', 'zone:$crate']);
const translated = [];
for (const c of nativeCases) {
  const isCrate = c === crateCase;
  const source = {id: isCrate ? '$crate' : '$player', position: [...c.playerLocation], rotation: [...c.oldRotation],
    flags: isCrate ? 13 : 15, radius: isCrate ? 34 : 17, height: isCrate ? 23.25 : 42,
    pawn: !isCrate, mapActor: isCrate, standingCount: c.standingCount ?? 1,
    static: false, movable: true, base: isCrate ? {id: '$world'} : null, touching: [null, null, null, null]};
  const rider = {id: isCrate ? '$crate-rider' : '$rider', position: [...c.riderLocation], rotation: [...c.riderRotation],
    flags: isCrate ? 13 : 0, radius: isCrate ? 34 : 0, height: isCrate ? 23.25 : 0, pawn: false,
    scriptView: !isCrate, mapActor: isCrate, standingCount: c.riderStandingCount ?? 0,
    static: false, movable: true, base: source, touching: [null, null, null, null]};
  const actors = [source, rider], worldActor = {id: '$world'};
  const events = [], encroachmentCalls = [], recursiveCalls = [];
  const services = {
    worldActor, multiLineCheck: () => [],
    checkEncroachment: (actor, position, rotation, notify) => {
      encroachmentCalls.push({source: actor.id, position: [...position], rotation: [...rotation], notify, rejected: false});
      return false;
    },
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
      moveActor: (other, delta, newRotation) => {
        recursiveCalls.push({actor: other.id, delta: [...delta], rotation: [...newRotation], flags: [0,0,1,0]});
        return playerMove(other, delta, {...services, ignoreBases:true}, newRotation).success;
      },
      actorLocation: () => [...base.position], actorRotation: () => [...base.rotation],
    }),
  };
  const level = {editor: false, moveActor: (actor, delta, rotation, hit, ...flags) => {
    assert.equal(actor, source);
    assert.deepEqual(delta, c.delta ?? [0, 0, 0]);
    assert.deepEqual(rotation, c.newRotation);
    assert.deepEqual(hit, [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, -1]);
    assert.deepEqual(flags, [0, 0, 0, 0]);
    return playerMove(actor, delta, services, rotation).success;
  }};
  // SetRotation always moves with a zero Delta; the tiny case is the rider pass of a turning pawn, so it calls MoveActor with its Delta (the ULevel entry setScriptRotation reaches)
  if (c === tinyCase) {
    const moved = playerMove(source, c.delta, services, c.newRotation).success;
    const expectedTiny = native.results[nativeCases.indexOf(c)];
    assert.equal(moved, expectedTiny.success, `${c.name}: MoveActor result`);
    assert.deepEqual(source.position, expectedTiny.playerLocation, `${c.name}: source position`);
    assert.deepEqual(source.rotation, expectedTiny.playerRotation, `${c.name}: source rotation`);
    assert.deepEqual(rider.position, expectedTiny.riderLocation, `${c.name}: rider position`);
    assert.deepEqual(rider.rotation, expectedTiny.riderRotation, `${c.name}: rider rotation`);
    assert.deepEqual(events, expectedTiny.events, `${c.name}: move/hash/zone order`);
    assert.deepEqual(recursiveCalls, expectedTiny.riderMoveCalls, `${c.name}: recursive MoveActor args`);
    assert.deepEqual(encroachmentCalls, expectedTiny.checkEncroachment, `${c.name}: CheckEncroachment calls`);
    translated.push({name: c.name, result: moved, playerLocation: source.position, playerRotation: source.rotation, riderLocation: rider.position,
      riderRotation: rider.rotation, events, recursiveCalls, checkEncroachment: encroachmentCalls});
    continue;
  }
  const result = setScriptRotation(source, c.newRotation, {levelFor: () => level,
    read: (actor, field) => ({Rotation: actor.rotation, StandingCount: actor.standingCount,
      Brush: null, bStatic: actor.static, bMovable: actor.movable})[field],
    write: (actor, field, value) => { if (field === 'Rotation') actor.rotation = [...value]; }});
  const expected = native.results[nativeCases.indexOf(c)];
  assert.equal(result, expected.success, `${c.name}: SetRotation result`);
  assert.deepEqual(source.position, expected.playerLocation, `${c.name}: source position`);
  assert.deepEqual(source.rotation, expected.playerRotation, `${c.name}: source rotation`);
  assert.deepEqual(rider.position, expected.riderLocation, `${c.name}: rider position`);
  assert.deepEqual(rider.rotation, expected.riderRotation, `${c.name}: rider rotation`);
  assert.deepEqual(events, expected.events, `${c.name}: move/hash/zone order`);
  assert.deepEqual(recursiveCalls, expected.riderMoveCalls, `${c.name}: recursive MoveActor args`);
  assert.deepEqual(encroachmentCalls, expected.checkEncroachment, `${c.name}: CheckEncroachment calls`);
  translated.push({name: c.name, result, playerLocation: source.position,
    playerRotation: source.rotation, riderLocation: rider.position,
    riderRotation: rider.rotation, events, recursiveCalls, checkEncroachment: encroachmentCalls});
}
await writeFile(path.join(dir, 'translation-comparison.json'), JSON.stringify({
  cases: translated, mismatches: [], scope: 'setScriptRotation -> live-level MoveActor -> playerMove/moveActorRiders',
}, null, 2));
console.log('Production SetRotation/playerMove/moveActorRiders matches both player rider records, the one-rider Training crate reference and the tiny-nonzero-Delta rider pass.');
console.log(JSON.stringify({cases: nativeCases.map((c, i) => ({name: c.name, result: native.results[i]})), hashes: native.hashes}, null, 2));
