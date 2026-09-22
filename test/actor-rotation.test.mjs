import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedTurn, performPhysicsTail, physicsRotation, physicsRotationGate, rotationDelta } from '../src/runtime/actor-rotation.mjs';

// Expectations captured from the original performPhysics/physicsRotation by
// scripts/validate-native-actor-rotation.mjs.
const f = Math.fround;
function actor(changes = {}) {
  const events = [];
  const a = { rotation: [0, 0, 0], rotationRate: [0, 0, 0], desiredRotation: [0, 0, 0], bFixedRotationDir: false,
    bRotateToDesired: false, pendingTouch: null, events, ...changes };
  const services = {
    moveActor(delta, rotation) { events.push({ moveActor: [...delta], rotation: [...rotation] }); a.rotation = rotation; return true; },
    isProbing: () => true,
    endedRotation() { events.push('EndedRotation'); },
    postTouch(target, other) { events.push({ postTouch: target.name, other }); },
  };
  return { a, services };
}

test('a fixed-direction fragment spin wraps every turned axis into [0, 65535]', () => {
  const { a, services } = actor({ bFixedRotationDir: true, rotation: [-528516343, 62239, 33959], rotationRate: [94580, 116932, 78228] });
  physicsRotation(a, f(1 / 60), services);
  assert.deepEqual(a.rotation, [33073, 64187, 35262]);
  assert.deepEqual(a.events, [{ moveActor: [0, 0, 0], rotation: [33073, 64187, 35262] }]);
});

test('rotating to desired clamps at the target and fires EndedRotation', () => {
  const { a, services } = actor({ bRotateToDesired: true, rotation: [0, 1000, 0], rotationRate: [0, 60000, 0], desiredRotation: [0, 1500, 0] });
  physicsRotation(a, f(.1), services);
  assert.deepEqual(a.rotation, [0, 1500, 0]);
  assert.deepEqual(a.events.at(-1), 'EndedRotation');
  const wrap = actor({ bRotateToDesired: true, rotation: [65000, 65000, 65000], rotationRate: [32767, 32767, 32767], desiredRotation: [500, 500, 500] });
  physicsRotation(wrap.a, f(1 / 30), wrap.services);
  assert.deepEqual(wrap.a.rotation, [500, 500, 500]);
});

test('a PHYS_Rotating camera sweep leaves a zero-rate axis untouched', () => {
  const { a, services } = actor({ bRotateToDesired: true, rotation: [7963, 51815, 0], rotationRate: [65535, 65535, 0], desiredRotation: [1675, 36787, -2] });
  performPhysicsTail(a, f(.005), services);
  assert.deepEqual(a.rotation, [7636, 51488, 0]);
  assert.equal(a.events.includes('EndedRotation'), false);
});

test('the int conversion keeps the exact x87 product', () => {
  assert.equal(rotationDelta(671088635, f(.4)), 268435457); // binary64 would give 268435458
  const { a, services } = actor({ bFixedRotationDir: true, rotation: [0, 12345, 0], rotationRate: [671088635, 671088635, 0] });
  physicsRotation(a, f(.4), services);
  assert.deepEqual(a.rotation, [1, 12346, 0]);
});

// Branch examples read from fixedTurn 0x103c9dc0; the validator's wrap/half-turn
// family checks these boundaries against the original instructions.
test('fixedTurn follows the original direction rules', () => {
  const both = { bFixedRotationDir: true, bRotateToDesired: true };
  assert.equal(fixedTurn(70000, 0, 0, both), 4464);
  assert.equal(fixedTurn(100, 50, 30, both), 130);          // fixed direction, far way round
  assert.equal(fixedTurn(100, 120, 30, both), 120);         // stops at desired
  assert.equal(fixedTurn(100, 120, -30, both), 70);
  assert.equal(fixedTurn(0, 32768, 100, { bRotateToDesired: true }), 65436); // half turn goes negative
  assert.equal(fixedTurn(0, 32767, -100, { bRotateToDesired: true }), 100);  // |rate| toward the short way
  assert.equal(fixedTurn(5, 9, 100, {}), 5);
});

test('the performPhysics gate and PendingTouch tail', () => {
  assert.equal(physicsRotationGate([65536, -131072, 0]), false);
  assert.equal(physicsRotationGate([0, 0, 65535]), true);
  const touch1 = { name: 'touch1', pendingTouch: null }, touch0 = { name: 'touch0', pendingTouch: touch1 };
  const { a, services } = actor({ bFixedRotationDir: true, rotation: [0, 100, 0], rotationRate: [0, 20000, 0], pendingTouch: touch0 });
  performPhysicsTail(a, f(.05), services);
  assert.deepEqual(a.rotation, [0, 1100, 0]);
  assert.deepEqual(a.events.at(-1), { postTouch: 'touch0', other: a });
  assert.equal(a.pendingTouch, touch1);
  assert.equal(touch0.pendingTouch, null);
});

test('physicsRotation requires its explicit services', () => {
  assert.throws(() => physicsRotation(actor().a, f(.1), {}), /explicit moveActor/);
});
