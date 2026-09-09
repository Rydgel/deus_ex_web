import test from 'node:test';
import assert from 'node:assert/strict';
import { relocationFixture } from '../scripts/validate-native-relocation.mjs';

test('original FarMove test writes both locations without detaching or teleport flag', () => {
  const state = relocationFixture({ test: 1, standingCount: 1, children: [true], fitted: [9,8,7] });
  assert.deepEqual(state.position, [9,8,7]);
  assert.deepEqual(state.oldLocation, [9,8,7]);
  assert.equal(state.motionFlags, 0);
  assert.deepEqual(state.childrenBased, [true]);
  assert.deepEqual(state.events.map(e => e.event), ['remove','findSpot','add','zone']);
  assert.deepEqual(state.events.at(-1).options, [1,0]);
});

test('original FarMove detaches based children in level order before location stores', () => {
  const state = relocationFixture({ standingCount: 1, children: [true,false,true] });
  assert.deepEqual(state.events.map(e => e.event), ['remove','findSpot','encroachment','setBase','setBase','add','zone']);
  assert.deepEqual(state.events.filter(e => e.event === 'setBase').map(e => e.actor), [0,2]);
  assert.deepEqual(state.events[3].before.position, [1,2,3]);
  assert.deepEqual(state.childrenBased, [false,false,false]);
  assert.equal(state.motionFlags, 0x100);
});

test('encroachment rejection reinserts at old position and skips zone callback', () => {
  const state = relocationFixture({ encroached: true, fitted: [9,8,7] });
  assert.equal(state.success, false);
  assert.deepEqual(state.position, [1,2,3]);
  assert.deepEqual(state.oldLocation, [4,5,6]);
  assert.equal(state.registered, true);
  assert.deepEqual(state.events.map(e => e.event), ['remove','findSpot','encroachment','add']);
});

test('native SetCollisionSize stores requested negatives between hash operations', () => {
  const state = relocationFixture({ newSize: [-1,-2] });
  assert.deepEqual(state.events.map(e => [e.event,e.before.radius,e.before.height]), [['remove',20,43],['add',-1,-2]]);
  assert.equal(state.radius,-1); assert.equal(state.height,-2);
});
