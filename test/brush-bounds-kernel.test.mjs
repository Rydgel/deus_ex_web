import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTraceKernel } from '../src/runtime/trace-kernel.mjs';
import { brushCollisionBounds, brushCollisionBoundsReference } from '../src/runtime/brush-bounds.mjs';

const kernel = await loadTraceKernel();
const model = { bounds: { min: [-13.25, -27.5, -3.125], max: [48.75, 56, 18.5], valid: true } };
const same = (a, b) => ['min', 'max'].every(key => a[key].every((v, i) => Object.is(v, b[key][i]))) && a.valid === b.valid;
const owners = [
  { Location: [100.25, -32.125, 12], Rotation: [0, 16384, 0], PrePivot: [12, 13, 14], MainScale: { scale: [2, .5, -1], shearAxis: 3, shearRate: .6 }, PostScale: { scale: [.75, 1.5, 2], shearAxis: 3, shearRate: -.6 } },
  { Location: [32, 48, -304], Rotation: [32768, 19190, -32768], PrePivot: [43.7239990234375, -92.95795440673828, -39] },   // DeusExMover1 of 09_NYC_ShipFan
  { Location: [0, 0, 0], Rotation: [2049, -3191, 4097] },
  { Rotation: [-2147483648, 2147483647, 8192] },
  {},
];

test('the Rust twin of a brush world box equals the JavaScript reference bit for bit', { skip: !kernel }, () => {
  for (const owner of owners) {
    const got = kernel.brushBounds(model, owner);
    assert.ok(got, `the kernel answers ${JSON.stringify(owner)}`);
    assert.ok(same(got, brushCollisionBoundsReference(model, owner)), JSON.stringify({ owner, got, reference: brushCollisionBoundsReference(model, owner) }));
    assert.ok(same(brushCollisionBounds(model, owner), got), 'the dispatcher answers with the kernel');
  }
});

test('what the reference throws on or the kernel cannot read goes back to the reference', { skip: !kernel }, () => {
  for (const owner of [{ MainScale: { scale: [0, 1, 1] } }, { PostScale: { scale: [1, NaN, 1] } }, { Location: [Infinity, 0, 0] }, { Rotation: [0.5, 0, 0] }, { Location: [1, 2] }, { MainScale: null }]) {
    assert.equal(kernel.brushBounds(model, owner), undefined, JSON.stringify(owner));
  }
  assert.throws(() => brushCollisionBounds(model, { MainScale: { scale: [0, 1, 1] } }), /Zero or nonfinite brush scale/);
});

test('a null owner is the model box, untouched by the kernel', () => {
  const box = brushCollisionBounds(model, null);
  assert.deepEqual(box, { min: [-13.25, -27.5, -3.125], max: [48.75, 56, 18.5], valid: true });
  assert.notEqual(box.min, model.bounds.min);
});
