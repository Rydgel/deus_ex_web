import test from 'node:test';
import assert from 'node:assert/strict';
import { findSpot } from '../src/runtime/fitting.mjs';
import { traceRay } from '../src/runtime/ray.mjs';
import { pointCheck, modelPointCheck } from '../src/runtime/point-check.mjs';
import { createCollisionHash, collisionHashLineBounds } from '../src/runtime/collision-hash.mjs';
import { x87C0, x87C0C3, x87CompareFlags } from '../src/runtime/x87-nan.mjs';
import { modelFromObjects } from '../src/unreal/bsp-model.mjs';

// docs/fitting.md "NaN in FindSpot". The expectations of the BSP cases are Engine.dll's own answers under Unicorn
// (scripts/native-collision-oracle.py on these two compiled models); the end-to-end evidence over the Island's tracked
// model and hash is scripts/validate-native-findspot-nan.mjs.

test('x87 compare flags: an unordered pair sets C3, C2 and C0', () => {
  assert.equal(x87CompareFlags(1, 2), 0x0100);
  assert.equal(x87CompareFlags(2, 2), 0x4000);
  assert.equal(x87CompareFlags(3, 2), 0);
  for (const pair of [[NaN, 1], [1, NaN], [NaN, NaN]]) {
    assert.equal(x87CompareFlags(...pair), 0x4500);
    assert.ok(x87C0(...pair) && x87C0C3(...pair));
  }
  assert.ok(x87C0(1, 2) && !x87C0(2, 2) && !x87C0(3, 2));
  assert.ok(x87C0C3(1, 2) && x87C0C3(2, 2) && !x87C0C3(3, 2));
});

test('AdjustSpot adjusts on a NaN Time and FindSpot then refuses the NaN candidate', () => {
  const lines = [], points = [];
  const queries = {
    pointCheck(position) { points.push(position); return 0; },
    // the first probe meets a NaN Time (the mover recovery of a zero-length segment); every later probe is a NaN start, blocked at time 0
    lineCheck(start) { lines.push(start); return lines.length === 1 ? { time: NaN, normal: [1, 0, 0] } : { time: 0, normal: [1, -0, -0] }; },
  };
  assert.equal(findSpot(queries, [7713.68701171875, 708.2366943359375, -126.47925567626953], [6, 6, 0], 0, 1), null);
  // the initial point check, the six axis probes, the point check on the NaN candidate, the eight corner probes; no final point check
  assert.equal(lines.length, 14);
  assert.equal(points.length, 2);
  assert.ok(points[1].every(Number.isNaN), 'the post-axis point check runs on a NaN candidate');
  for (const start of lines.slice(1)) assert.ok(start.every(Number.isNaN));
  assert.equal(findSpot({ ...queries, pointCheck: () => 1 }, [0, 0, 0], [6, 6, 0], 0, 1) !== null, true);
});

test('a NaN displacement fails FindSpot even when the point checks accept it', () => {
  let calls = 0;
  const queries = { pointCheck: () => (++calls === 1 ? 0 : 1), lineCheck: (start, end) => (calls === 1 && start[0] === 5 && end[0] === -1 ? { time: NaN, normal: [1, 0, 0] } : { time: 1, normal: [0, 0, 0] }) };
  // the post-axis point check (call 2) accepts the NaN candidate: FindSpot returns it, as the original's compare chain does before the displacement test
  assert.ok(findSpot(queries, [5, 0, 0], [6, 6, 0], 0, 1)?.every(Number.isNaN));
  // ... unless the post-axis check refuses: the corner probes, then FCOMPP of 1.5 * SizeSquared() against the NaN displacement is C0
  let n = 0;
  const refusing = { pointCheck: () => (++n <= 2 ? 0 : 1), lineCheck: queries.lineCheck };
  calls = 1;
  assert.equal(findSpot(refusing, [5, 0, 0], [6, 6, 0], 0, 1), null);
});

test('finite Time behaviour is unchanged: Time 1 and above does not adjust, below does', () => {
  const adjust = time => { const starts = []; findSpot({ pointCheck: () => 0, lineCheck(start) { starts.push(start); return starts.length === 1 ? { time, normal: [1, 0, 0] } : { time: 1, normal: [0, 0, 0] }; } },
    [0, 0, 0], [6, 6, 0], 0, 1); return starts[1][0]; };
  assert.equal(adjust(1), 0);
  for (const t of [0.5, 0]) assert.equal(adjust(t), Math.fround(Math.fround(1.05 - t) * 6)); // X: factor stored, times Normal.X, times Size, stored
});

const oneWall = modelFromObjects({ rootOutside: 1, leafHulls: [], nodes: [{ plane: [1, 0, 0, 0], front: -1, back: -1, vertexCount: 4, flags: 0, collisionBound: -1 }] });
const NAN3 = [NaN, NaN, NaN];

test('a NaN ray in a solid leaf: time 0, the NaN start, the root normal facing the other way (C0 on unordered)', () => {
  for (const [start, end] of [[NAN3, NAN3], [[-10, 0, 0], NAN3], [NAN3, [-10, 0, 0]]]) {
    const hit = traceRay(oneWall, start, end);
    assert.equal(hit.time, 0);
    assert.ok(hit.location.every(Number.isNaN));
    assert.deepEqual(hit.normal, [-1, -0, -0]); // Engine.dll 0x103f3c20: normal (-1, -0, -0)
  }
});

function boxModel() {
  const planes = [[-1, 0, 0, 10], [1, 0, 0, 10], [0, -1, 0, 10], [0, 1, 0, 10], [0, 0, -1, 10], [0, 0, 1, 10]];
  const view = new DataView(new ArrayBuffer(4));
  const bits = v => { view.setFloat32(0, v, true); return view.getInt32(0, true); };
  return modelFromObjects({ rootOutside: 1, leafHulls: [0, 1, 2, 3, 4, 5, -1, ...[-10, -10, -10, 10, 10, 10].map(bits)],
    nodes: planes.map((plane, i) => ({ plane, back: i === 5 ? -1 : i + 1, front: -1, collisionBound: 0, vertexCount: 4, flags: 0 })) });
}

test('a point with a NaN component is blocked at zero and nonzero extents, as UModel::PointCheck (0x103f1570) answers', () => {
  const model = boxModel();
  for (const extent of [[0, 0, 0], [1, 1, 1], [20, 20, 43]]) for (const position of [NAN3, [NaN, 0, 0], [0, NaN, 0], [0, 0, NaN]]) {
    assert.equal(pointCheck(model, position, extent), false, `${position} ${extent}`);
    const hit = modelPointCheck(model, position, extent);
    assert.equal(hit.outside, false);
    assert.deepEqual(hit.normal, [0, 0, 0]);
    assert.equal(hit.time, 0);
    position.forEach((v, i) => assert.ok(Object.is(hit.location[i], v) || (Number.isNaN(v) && Number.isNaN(hit.location[i]))));
  }
});

test('the hash walks one cell for a NaN line and visits no actor; one NaN vector stays unsupported', () => {
  assert.deepEqual(collisionHashLineBounds({ start: NAN3, end: NAN3 }), { min: [0, 0, 0], max: [0, 0, 0] });
  assert.deepEqual(collisionHashLineBounds({ start: NAN3, end: NAN3, extent: [6, 6, 0] }), { min: [0, 0, 0], max: [0, 0, 0] });
  const hash = createCollisionHash();
  hash.addActor({ id: 'a' }, { min: [0, 0, 0], max: [256, 256, 256] });
  let visited = 0;
  assert.deepEqual(hash.actorLineCheck({ start: NAN3, end: NAN3 }, () => { visited++; return 1; }), []);
  assert.equal(visited, 0);
  assert.throws(() => hash.actorLineCheck({ start: NAN3, end: [0, 0, 0] }, () => 1), /finite/);
  assert.throws(() => hash.actorLineCheck({ start: [0, 0, 0], end: NAN3 }, () => 1), /finite/);
  assert.throws(() => collisionHashLineBounds({ start: [NaN, 0, 0], end: [NaN, 0, 0] }), /finite/);
});
