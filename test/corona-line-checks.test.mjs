import test from 'node:test';
import assert from 'node:assert/strict';
import { coronaLineVisible } from '../src/runtime/coronas.mjs';
import { createLevelQueries } from '../src/runtime/level-queries.mjs';
import { loadTraceKernel } from '../src/runtime/trace-kernel.mjs';
import { traceExtent } from '../src/runtime/extent-trace.mjs';

// The corona helper's line checks (Render.dll 0x10b1bc00, docs/coronas.md):
// validate-coronas.mjs compares their arguments with the original helper's.
// These are regressions for Play's wiring; the cylinder answers below are
// UPrimitive::LineCheck's (docs/primitive-collision.md), whose start-inside
// branch the native captures in primitive-collision.test.mjs establish.
test('coronaLineVisible traces from the light to the frame origin, Level|Movers then Pawns|Others', () => {
  const location = [1, 2, 3], origin = [4, 5, 6], viewer = { name: 'viewer' }, other = { name: 'other' };
  const run = answers => {
    const calls = [];
    const visible = coronaLineVisible((...args) => { calls.push(args); return answers.shift(); }, location, origin, viewer);
    return { visible, calls };
  };
  const first = run([{ outside: false, actor: null }]);
  assert.equal(first.visible, false);
  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0][0], location);
  assert.equal(first.calls[0][1], origin);
  assert.deepEqual(first.calls[0].slice(2), [[0, 0, 0], 6, 0, null]);
  const clear = run([{ outside: true }, { outside: true, actor: null }]);
  assert.equal(clear.visible, true);
  assert.equal(clear.calls[1][0], location);
  assert.equal(clear.calls[1][1], origin);
  assert.deepEqual(clear.calls[1].slice(2), [[0, 0, 0], 0x11, 0, null]);
  assert.equal(run([{ outside: true }, { outside: false, actor: viewer }]).visible, true);
  assert.equal(run([{ outside: true }, { outside: false, actor: other }]).visible, false);
});

// 09_NYC_ShipFan's fan2 view: Lightbulb12 (CollisionRadius 1.6, Height 2.9)
// holds Light34 0.37 above its bottom cap; the eye is inside the viewer's
// cylinder. The light's horizontal offset points away from the eye, so a
// trace from the light starts inside heading in and hits the bulb at time 0.
// The same light mirrored through the bulb's axis heads out: the bulb is
// skipped and the trace ends on the viewer. Traced the other way, from the
// eye, both would end inside the bulb and hit it.
test('a light inside a colliding cylinder: hidden only when the eye lies inward (09_NYC_ShipFan fan2)', async () => {
  await loadTraceKernel();
  const bulbLocation = [-271.79, 274.31, 87.67], light = [-272.30, 273.81, 85.14], eye = [236, -238, -55];
  const mirrored = [2 * bulbLocation[0] - light[0], 2 * bulbLocation[1] - light[1], light[2]];
  const model = { nodes: [], surfaces: [], points: [], vectors: [], verts: [] };
  for (const kernel of [false, true]) {
    const bulb = { name: 'Lightbulb12', collisionBits: 1 | 4, actorFlags: 0,
      lineage: ['deusex.lightbulb', 'deusex.deusexdecoration', 'engine.decoration', 'engine.actor'],
      values: { Location: bulbLocation, CollisionRadius: 1.6, CollisionHeight: 2.9, bCollideActors: true, bBlockActors: true } };
    const viewer = { name: 'JCDentonMale', collisionBits: 1 | 4 | 8, actorFlags: 0, lineage: ['engine.pawn', 'engine.actor'],
      values: { Location: [236, -238, -85], CollisionRadius: 20, CollisionHeight: 43, bCollideActors: true } };
    const queries = createLevelQueries(model, [bulb, viewer], { kernel, extentCheck: traceExtent });
    const lineCheck = (...args) => queries.lineCheck(...args);
    const where = kernel ? 'kernel' : 'JavaScript';
    const inward = queries.lineCheck(light, eye, [0, 0, 0], 0x11, 0, null);
    assert.equal(inward.actor, bulb, `${where}: Light34's trace hits the bulb`);
    assert.equal(inward.time, 0, `${where}: at its start`);
    assert.equal(coronaLineVisible(lineCheck, light, eye, viewer), false, `${where}: Light34 is hidden`);
    assert.equal(queries.lineCheck(mirrored, eye, [0, 0, 0], 0x11, 0, null).actor, viewer, `${where}: the mirrored light's trace ends on the viewer`);
    assert.equal(coronaLineVisible(lineCheck, mirrored, eye, viewer), true, `${where}: the mirrored light is visible`);
    for (const end of [light, mirrored])
      assert.equal(queries.lineCheck(eye, end, [0, 0, 0], 0x11, 0, null).actor, bulb, `${where}: from the eye, the bulb hides both`);
  }
});
