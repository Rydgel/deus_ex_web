import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneEvents } from '../src/runtime/scene-events.mjs';

// The scene-event adapter routes any actor/event outside its recovered
// native-semantics branches (player, Triggers Touch/UnTouch, DeusExMover
// TriggerToggle) to the general VM router `dispatchEvent`. These check the
// delegation contract in isolation; the live VM behavior is covered by
// validate-plant-push / validate-decoration-settle-roll / validate-gameplay.

const player = { name: 'JC', lineage: ['engine.pawn', 'deusex.deusexplayer'] };
function harness(overrides = {}) {
  const calls = [];
  const dispatch = createSceneEvents(player, {
    deferMissionEvent: (target, event) => calls.push({ defer: `${target.name}.${event}` }),
    dispatchEvent: (target, event, args) => { calls.push({ vm: `${target.name}.${event}`, args }); if (overrides.throws) throw overrides.throws; return overrides.outcome ?? { handled: false }; },
    ...overrides.options,
  });
  return { dispatch, calls };
}

test('an unhandled actor event routes to the general VM router', () => {
  const { dispatch, calls } = harness({ outcome: { handled: true, result: 'ran' } });
  const plant = { name: 'Plant7', lineage: ['deusex.deusexdecoration', 'engine.decoration'] };
  const result = dispatch(plant, 'Bump', [player]);
  assert.equal(result, 'ran', 'returns the VM body result');
  assert.deepEqual(calls, [{ vm: 'Plant7.Bump', args: [player] }], 'delegated the decoration Bump to the router (no special-case)');
});

test('a router no-op (no such function) is the original empty-event no-op', () => {
  const { dispatch, calls } = harness({ outcome: { handled: false } });
  const actor = { name: 'Foo', lineage: ['engine.actor'] };
  const result = dispatch(actor, 'Frob', [player]);
  assert.equal(result, undefined, 'an absent function returns nothing, like an empty event');
  assert.deepEqual(calls, [{ vm: 'Foo.Frob', args: [player] }]);
});

test('player native branches do not reach the VM router', () => {
  const { dispatch, calls } = harness();
  // Player contact events are dry no-ops handled in the player branch.
  assert.equal(dispatch(player, 'Bump', [{ name: 'X' }]), undefined);
  assert.deepEqual(calls, [], 'no VM routing or deferral for the player native branch');
});

test('Trigger Touch/UnTouch route through the VM router, running when handled', () => {
  // A handled trigger event (e.g. a datalink) runs its real bytecode; no deferral.
  const { dispatch, calls } = harness({ outcome: { handled: true, result: undefined } });
  const trigger = { name: 'Trig', lineage: ['engine.triggers'] };
  dispatch(trigger, 'Touch', [player]);
  assert.deepEqual(calls, [{ vm: 'Trig.Touch', args: [player] }], 'ran the real Touch, did not defer');
});

test('Trigger Touch/UnTouch defer as mission scripts when the router does not handle them', () => {
  // An unhandled trigger event (no such function) records a deferred mission-script effect.
  const { dispatch, calls } = harness({ outcome: { handled: false } });
  const trigger = { name: 'Trig', lineage: ['engine.triggers'] };
  dispatch(trigger, 'Touch', [player]);
  dispatch(trigger, 'UnTouch', [player]);
  assert.deepEqual(calls, [
    { vm: 'Trig.Touch', args: [player] }, { defer: 'Trig.Touch' },
    { vm: 'Trig.UnTouch', args: [player] }, { defer: 'Trig.UnTouch' },
  ], 'routed first, then deferred');
});

test('a trigger body that hits an unbuilt boundary defers instead of pausing', () => {
  // A recognized "unbuilt subsystem" error is recorded as a deferred effect (record-as-boundary).
  const { dispatch, calls } = harness({ throws: new Error('Original function is not prepared: engine.trigger.isrelevant') });
  const trigger = { name: 'Trig', lineage: ['engine.triggers'] };
  assert.doesNotThrow(() => dispatch(trigger, 'Touch', [player]));
  assert.deepEqual(calls, [{ vm: 'Trig.Touch', args: [player] }, { defer: 'Trig.Touch' }]);
});

test('a real (non-boundary) trigger error still pauses honestly', () => {
  const { dispatch } = harness({ throws: new TypeError('cannot read property of undefined') });
  const trigger = { name: 'Trig', lineage: ['engine.triggers'] };
  assert.throws(() => dispatch(trigger, 'Touch', [player]), /cannot read property/);
});

test('without a linked router, an unhandled event still pauses honestly', () => {
  const dispatch = createSceneEvents(player, { deferMissionEvent: () => {} });
  const plant = { name: 'Plant7', lineage: ['deusex.deusexdecoration'] };
  assert.throws(() => dispatch(plant, 'Bump', [player]), /Unsupported original scene event: Plant7\.Bump/);
});
