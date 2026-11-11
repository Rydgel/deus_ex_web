import test from 'node:test';
import assert from 'node:assert/strict';

// The recorder for Stage 7's checks by hand (src/viewer/hand-checks.mjs) is opt-in: without ?checks=1 (and outside a page) it does nothing.
test('the hand-check recorder does nothing without its switch', async () => {
  const before = Object.keys(globalThis).length;
  const { checksEnabled } = await import('../src/viewer/hand-checks.mjs');
  assert.equal(checksEnabled, false);
  assert.ok(!('deusExChecks' in globalThis));
  assert.equal(Object.keys(globalThis).length, before);
});
